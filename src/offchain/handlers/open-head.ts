import {
  Address,
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
  getNetworkFromLucid,
  getValidator,
  waitForUtxosUpdate,
} from '../lib/utils';
import _ from 'lodash';
import { mergeFunds } from '../tx-builders/merge-funds';
import { buildIncrementalCommitBlueprint } from '../tx-builders/commit-funds';
import { DBStatus } from '../../shared/prisma-schemas';
import { DBOps } from '../../prisma/db-ops';
import { logger } from '../../shared/logger';

/**
 * Sends the Init request to the hydra node and waits for HeadIsOpen.
 * In Hydra 2.x "directly open heads", Init opens an EMPTY head immediately.
 * Adds a new process to the database and returns the process ID.
 */
async function handleOpenHead(
  lucid: LucidEvolution
): Promise<{ operationId: string }> {
  const { ADMIN_NODE_WS_URL: wsUrl } = env;
  const localLucid = _.cloneDeep(lucid);
  localLucid.selectWallet.fromSeed(env.SEED);
  const hydra = new HydraHandler(localLucid, wsUrl);
  try {
    logger.debug('Opening head (directly open in Hydra 2.x)...');
    await hydra.init(); // resolves on HeadIsOpen (empty head)
    const processId = await DBOps.newHead();
    await hydra.stop();
    return { operationId: processId };
  } catch (error) {
    logger.error('Error while opening head');
    await hydra.stop();
    throw error;
  }
}

/** Deposit one batch of script-locked UTxOs into the OPEN head via /commit blueprint. */
async function commitFundsToHead(
  hydra: HydraHandler,
  lucid: LucidEvolution,
  fundUtxo: UTxO,
  validatorRef: UTxO
): Promise<string> {
  const blueprint = await buildIncrementalCommitBlueprint(lucid, {
    adminAddress: await lucid.wallet().address(),
    depositedUtxo: fundUtxo,
    validatorRefUtxo: validatorRef,
  });
  // The /commit utxo context must include the validator reference-script UTxO so
  // Hydra can resolve the script the blueprint references (else: "missing script
  // witness"). It is a reference input, not a spend input, so it is NOT committed.
  return hydra.commit(
    `${env.ADMIN_NODE_API_URL}/commit`,
    [fundUtxo, validatorRef],
    blueprint
  );
}

/**
 * Finalizes the open head process by collecting user deposits, merging them, and committing to the hydra head.
 * @param lucid Lucid instance
 * @param params Parameters for managing the head (peer urls unused in 2.x — deposits + snapshot approval)
 * @param processId DB process Id of this Open head operation
 */
async function finalizeOpenHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema,
  processId: string
) {
  // peer urls unused in 2.x (deposits + snapshot approval)
  void params;
  const localLucid = _.cloneDeep(lucid);
  localLucid.selectWallet.fromSeed(env.SEED);
  const network = getNetworkFromLucid(localLucid);
  const { VALIDATOR_REF: vRef } = env;
  const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
  try {
    const adminAddress = await localLucid.wallet().address();
    const [validatorRef] = await localLucid.utxosByOutRef([{ txHash: vRef, outputIndex: 0 }]);
    const validator = getValidator(validatorRef);
    const scriptAddress = validatorToAddress(network, validator);
    const scriptUtxos = await localLucid.utxosAt(scriptAddress);

    const depositsByDatum = collectDeposits(scriptUtxos);
    const utxosToCommit = await mergeDeposits(
      processId, localLucid, adminAddress, validatorRef, depositsByDatum
    );

    await DBOps.updateHeadStatus(processId, DBStatus.COMMITTING);
    for (const fundUtxo of utxosToCommit) {
      const depositTxId = await commitFundsToHead(hydra, localLucid, fundUtxo, validatorRef);
      logger.info(`Committed fund UTxO into head (deposit ${depositTxId})`);
    }
    await DBOps.updateHeadStatus(processId, DBStatus.RUNNING);
    await hydra.stop();
  } catch (error) {
    logger.error('Error while funding head');
    await DBOps.updateHeadStatus(processId, DBStatus.FAILED);
    await hydra.stop();
    throw error;
  }
}

/**
 * Returns a Map with datum as keys and a list of UTxOs with that datum as values.
 * This groups UTxOs by their full datum (not just address) because the validator
 * requires all inputs in a merge to have exactly the same datum.
 */
function collectDeposits(scriptUtxos: UTxO[]): Map<string, UTxO[]> {
  const datumToDepositsMap = new Map<string, UTxO[]>();
  for (const utxo of scriptUtxos) {
    // Use the full datum as the grouping key since the validator requires
    // all merged inputs to have exactly the same datum
    const datumKey = utxo.datum!;
    if (!datumToDepositsMap.has(datumKey)) {
      datumToDepositsMap.set(datumKey, []);
    }
    datumToDepositsMap.get(datumKey)!.push(utxo);
  }
  return datumToDepositsMap;
}

/**
 * Merges deposits with matching datums into single UTxOs, and returns the list of merged UTxOs.
 * This is necessary to reduce the number of UTxOs that will be committed in the next step.
 * @param processId DB process Id of this Open head operation
 * @param localLucid Lucid instance
 * @param adminAddress Admin bech32 address
 * @param validatorRef Validator script UTxO reference
 * @param depositsByDatum Map of datum to list of deposit UTxOs with that datum
 * @returns
 */
async function mergeDeposits(
  processId: string,
  localLucid: LucidEvolution,
  adminAddress: string,
  validatorRef: UTxO,
  depositsByDatum: Map<string, UTxO[]>
): Promise<UTxO[]> {
  const mergeTxs: string[] = [];
  const fundsRefs: OutRef[] = [];
  let currentAdminUtxos = await localLucid.utxosAt(adminAddress).then((utxos) =>
    selectUTxOs(utxos, {
      ['lovelace']: BigInt(depositsByDatum.size * 1_000_000 + 10_000_000),
    })
  );
  if (currentAdminUtxos.length === 0) {
    throw new Error('Insufficient admin funds');
  }
  logger.info('Preparing merge transactions...');
  for (const [, deposits] of depositsByDatum) {
    if (deposits.length === 1) {
      // Only one UTxO with this datum, no need to merge
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
