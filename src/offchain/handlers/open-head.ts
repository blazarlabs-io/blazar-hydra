import {
  Address,
  Data,
  LucidEvolution,
  OutRef,
  selectUTxOs,
  Transaction,
  UTxO,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import { ManageHeadSchema } from '../../shared';
import { HydraHandler } from '../lib/hydra';
import { env } from '../../config';
import {
  dataAddressToBech32,
  getNetworkFromLucid,
  getValidator,
  waitForUtxosUpdate,
} from '../lib/utils';
import _ from 'lodash';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { mergeFunds } from '../tx-builders/merge-funds';
import { logger } from '../../logger';
import { commitFunds } from '../tx-builders/commit-funds';
import { CommitFundsParams } from '../lib/params';
import { DBStatus } from '../../shared/prisma-schemas';
import { DBOps } from '../../prisma/db-ops';

const MAX_UTXOS_PER_COMMIT = 10;

/**
 * Sends the Init request to the hydra node and waits for the HeadIsInitialized confirmation tag.
 * Adds a new process to the database with status INITIALIZING and returns the process ID.
 */
async function handleOpenHead(
  lucid: LucidEvolution
): Promise<{ operationId: string }> {
  const { ADMIN_NODE_WS_URL: wsUrl } = env;
  try {
    const localLucid = _.cloneDeep(lucid);
    localLucid.selectWallet.fromSeed(env.SEED);

    // Step 1: Initialize the head
    logger.info('Initializing head...');
    const hydra = new HydraHandler(localLucid, wsUrl);
    let initTag = await hydra.init();
    initTag = await hydra.listen('HeadIsInitializing');
    if (initTag !== 'HeadIsInitializing') {
      logger.error(`Found tag: ${initTag}`);
    }
    const processId = await DBOps.newHead();
    await hydra.stop();
    return { operationId: processId };
  } catch (error) {
    logger.error('Error while initializing head');
    throw error;
  }
}

/**
 * Finalizes the open head process by collecting user deposits, merging them, and committing to the hydra head.
 * @param lucid Lucid instance
 * @param params Parameters for managing the head
 * @param processId DB process Id of this Open head operation
 */
async function finalizeOpenHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema,
  processId: string
) {
  const localLucid = _.cloneDeep(lucid);
  const network = getNetworkFromLucid(localLucid);
  const { peer_api_urls: peerUrls } = params;
  const { ADMIN_ADDRESS: adminAddress, VALIDATOR_REF: vRef } = env;
  try {
    const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);

    // Step 2: Lookup deposit UTxOs in L1
    const [validatorRef] = await localLucid.utxosByOutRef([
      { txHash: vRef, outputIndex: 0 },
    ]);
    const validator = getValidator(validatorRef);
    const scriptAddress = validatorToAddress(network, validator);
    const maxScriptUtxos = MAX_UTXOS_PER_COMMIT * peerUrls.length;
    const scriptUtxos = await localLucid
      .utxosAt(scriptAddress)
      .then((utxos) => utxos.slice(0, maxScriptUtxos));

    // Step 3: Collect deposits and merge them for each user
    const usersDeposits: Map<string, UTxO[]> = collectUsersDeposits(
      localLucid,
      scriptUtxos
    );
    const utxosToCommit: UTxO[] = await mergeDeposits(
      processId,
      localLucid,
      adminAddress,
      validatorRef,
      usersDeposits
    );

    // Step 4: Commit the funds to the hydra head
    await commitUtxos(
      processId,
      hydra,
      localLucid,
      utxosToCommit,
      peerUrls,
      adminAddress,
      validatorRef
    );

    await DBOps.updateHeadStatus(processId, DBStatus.AWAITING);
    let openHeadTag = '';
    while (openHeadTag !== 'HeadIsOpen') {
      logger.info('Head not opened yet');
      openHeadTag = await hydra.listen('HeadIsOpen');
    }
    await DBOps.updateHeadStatus(processId, DBStatus.RUNNING);

    await hydra.stop();
    return;
  } catch (error) {
    logger.error('Error while opening head, aborting...');
    console.error(error);
    await DBOps.updateHeadStatus(processId, DBStatus.FAILED);
    const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
    await hydra.abort();
    await hydra.listen('HeadIsAborted');
    await hydra.stop();
    throw error;
  }
}

/**
 * Returns a Map with user address as keys and a list of their deposit UTxOs as values.
 */
function collectUsersDeposits(
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
async function mergeDeposits(
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
async function commitUtxos(
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
async function submitMergeTxs(
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

export { handleOpenHead, finalizeOpenHead };
