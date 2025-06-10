import {
  Address,
  Data,
  LucidEvolution,
  OutRef,
  selectUTxOs,
  Transaction,
  UTxO,
} from '@lucid-evolution/lucid';
import { FundsDatum, FundsDatumT } from './types';
import { dataAddressToBech32, waitForUtxosUpdate } from './utils';
import { logger } from '../../logger';
import { mergeFunds } from '../tx-builders/merge-funds';
import { DBOps } from '../../prisma/db-ops';
import { DBStatus } from '../../shared/prisma-schemas';
import { HydraHandler } from './hydra';
import { CommitFundsParams } from './params';
import { commitFunds } from '../tx-builders/commit-funds';

/**
 * Returns a Map with user address as keys and a list of their deposit UTxOs as values.
 */
export function collectUsersDeposits(
  localLucid: LucidEvolution,
  scriptUtxos: UTxO[]
): Map<string, UTxO[]> {
  const userToDepositsMap = new Map<string, UTxO[]>();
  for (const utxo of scriptUtxos) {
    const { addr } = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
    const userAddress = dataAddressToBech32(localLucid, addr);
    if (!userToDepositsMap.has(userAddress)) {
      userToDepositsMap.set(userAddress, []);
    }
    userToDepositsMap.get(userAddress)!.push(utxo);
  }
  return userToDepositsMap;
}

/**
 * Merges user deposits into a single UTxO per user, and returns the list of UTxOs for all users.
 * This is necessary to reduce the number of UTxOs that will be committed in the next step.
 * @param thisProcessId DB process Id of this Open head operation
 * @param localLucid Lucid instance
 * @param adminAddress Admin bech32 address
 * @param validatorRef Validator script UTxO reference
 * @param usersDeposits Map of user address to list of deposit UTxOs
 * @returns
 */
export async function mergeDeposits(
  processId: string,
  localLucid: LucidEvolution,
  adminAddress: string,
  validatorRef: UTxO,
  usersDeposits: Map<string, UTxO[]>
): Promise<UTxO[]> {
  const mergeTxs: string[] = [];
  const fundsRefs: OutRef[] = [];
  let currentAdminUtxos = await localLucid.utxosAt(adminAddress).then((utxos) =>
    selectUTxOs(utxos, {
      ['lovelace']: BigInt(usersDeposits.size * 1_000_000 + 10_000_000),
    })
  );
  if (currentAdminUtxos.length === 0) {
    throw new Error('Insufficient admin funds');
  }
  logger.info('Preparing merge transactions...');
  for (const [, deposits] of usersDeposits) {
    if (deposits.length === 1) {
      // User has only one funds utxo, no need for a merge transaction
      const { txHash, outputIndex } = deposits[0];
      fundsRefs.push({ txHash, outputIndex });
      continue;
    }
    const { tx, newFundsUtxo, newAdminUtxos } = await mergeFunds(localLucid, {
      adminAddress,
      userFundsUtxos: deposits,
      adminUtxos: currentAdminUtxos,
      validatorRef: validatorRef,
    });
    const signedTx = await tx.sign
      .withWallet()
      .complete()
      .then((tx) => tx.toCBOR());
    fundsRefs.push(newFundsUtxo);
    mergeTxs.push(signedTx);
    currentAdminUtxos = newAdminUtxos;
  }

  if (mergeTxs.length > 0) {
    await DBOps.updateHeadStatus(processId, DBStatus.MERGING);
    logger.info('Submitting merge transactions...');
    await submitMergeTxs(localLucid, adminAddress, mergeTxs);
  }
  return await localLucid.utxosByOutRef(fundsRefs);
}

/**
 * Commits the UTxOs to the hydra head by sending commit transactions to each peer.
 * Each peer will submit a commit transaction with a portion of the UTxOs.
 * The last peer will also include the admin collateral UTxO.
 * @param processId DB process Id of this Open head operation
 * @param hydra HydraHandler instance
 * @param lucid Lucid instance
 * @param utxosToCommit List of UTxOs to commit
 * @param peerUrls List of peer URLs to send the commit transactions to
 * @param adminAddress Admin bech32 address
 * @param validatorRef Validator script UTxO reference
 */
export async function commitUtxos(
  processId: string,
  hydra: HydraHandler,
  lucid: LucidEvolution,
  fundUtxosToCommit: UTxO[],
  peerUrls: string[],
  adminAddress: string,
  validatorRef: UTxO
) {
  const adminCollateral = await lucid
    .utxosAt(adminAddress)
    .then((utxos) =>
      selectUTxOs(utxos, { ['lovelace']: 10_000_000n }).filter(
        (utxo) => Object.entries(utxo.assets).length === 1
      )
    )
    .then((utxos) => utxos.pop());
  if (!adminCollateral) {
    throw new Error(
      'No admin collateral found. Make sure to have a UTxO with just lovelace at the admin address.'
    );
  }
  const utxosPerPeer = 1 + fundUtxosToCommit.length / peerUrls.length;
  await DBOps.updateHeadStatus(processId, DBStatus.COMMITTING);

  for (let i = 0; i < peerUrls.length; i++) {
    const peerUrl = peerUrls[i];
    const thisPeerUtxos = fundUtxosToCommit.slice(0, utxosPerPeer);
    logger.debug(
      `Committing ${thisPeerUtxos.length} fund UTxOs to peer ${peerUrl}`,
      thisPeerUtxos.map((utxo) => {
        return { hash: utxo.txHash, idx: utxo.outputIndex };
      })
    );
    fundUtxosToCommit.splice(0, utxosPerPeer);

    const params: CommitFundsParams = {
      adminAddress,
      userFundUtxos: thisPeerUtxos,
      validatorRefUtxo: validatorRef,
    };
    const isLastCommit = i === peerUrls.length - 1;

    // Add admin collateral to the last commit tx
    if (isLastCommit) {
      params['adminCollateral'] = adminCollateral;
    }
    const commitUtxos = isLastCommit
      ? [...thisPeerUtxos, adminCollateral]
      : thisPeerUtxos;

    const { tx } = await commitFunds(lucid, params);
    const peerCommitTxId = await hydra.sendCommit(peerUrl, commitUtxos, tx);

    logger.info(`Commit transaction submitted! tx id: ${peerCommitTxId}`);
    let commitTag = '';
    logger.info('Waiting for last commit to be confirmed by the hydra node');
    while (commitTag !== 'Committed') {
      commitTag = await hydra.listen('Committed');
    }
  }
  logger.info('All funds committed successfully');
}

/**
 * Submits the signed merge transactions. The submission is sequential so it only waits for the
 * last transaction to be confirmed.
 * @param lucid Lucid instance
 * @param walletAddress Bech32 address of the wallet which signed the transactions
 * @param mergeTxs List of signed merge transactions in CBOR hex format
 */
export async function submitMergeTxs(
  lucid: LucidEvolution,
  walletAddress: Address,
  mergeTxs: Transaction[]
) {
  for (const tx of mergeTxs) {
    const txid = await lucid.wallet().submitTx(tx);
    logger.info(
      `Merge transaction submitted! tx id: https://preprod.cexplorer.io/tx/${txid}`
    );
  }
  const lastSubmittedTxHash = lucid
    .fromTx(mergeTxs[mergeTxs.length - 1])
    .toHash();
  logger.info(
    'Merge transactions submitted succesfully, last tx: ' + lastSubmittedTxHash
  );
  await waitForUtxosUpdate(lucid, walletAddress, lastSubmittedTxHash);
}
