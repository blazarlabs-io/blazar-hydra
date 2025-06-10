import {
  LucidEvolution,
  UTxO,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import { ManageHeadSchema } from '../../shared';
import { HydraHandler } from '../lib/hydra';
import { env } from '../../config';
import { getNetworkFromLucid, getValidator } from '../lib/utils';
import _ from 'lodash';
import { logger } from '../../logger';
import { DBStatus } from '../../shared/prisma-schemas';
import { DBOps } from '../../prisma/db-ops';
import {
  collectUsersDeposits,
  commitUtxos,
  mergeDeposits,
} from '../lib/hydra-flow-subroutines';

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
    if (initTag !== 'HeadIsInitializing') {
      logger.error(
        `Found tag: ${initTag}. Expected: HeadIsInitializing. Retrying...`
      );
      initTag = await hydra.listen('HeadIsInitializing');
    }
    const processId = await DBOps.newHead();
    await hydra.stop();
    return { operationId: processId };
  } catch (error) {
    logger.error('Error while initializing head');
    const hydra = new HydraHandler(lucid, env.ADMIN_NODE_WS_URL);
    await hydra.abort();
    await hydra.listen('HeadIsAborted');
    await hydra.stop();
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
  const { VALIDATOR_REF: vRef } = env;
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
    const adminAddress = await localLucid.wallet().address();
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
    await DBOps.updateHeadStatus(processId, DBStatus.FAILED);
    const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
    await hydra.abort();
    await hydra.listen('HeadIsAborted');
    await hydra.stop();
    throw error;
  }
}

export { handleOpenHead, finalizeOpenHead };
