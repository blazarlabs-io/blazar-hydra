import {
  Data,
  LucidEvolution,
  OutRef,
  selectUTxOs,
  UTxO,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { ManageHeadSchema } from "../../shared";
import { HydraHandler } from "../lib/hydra";
import { env, prisma } from "../../config";
import {
  dataAddressToBech32,
  getValidator,
  waitForUtxosUpdate,
} from "../lib/utils";
import _ from "lodash";
import { FundsDatum, FundsDatumT } from "../lib/types";
import { mergeFunds } from "../tx-builders/merge-funds";
import { logger } from "../../logger";
import { commitFunds } from "../tx-builders/commit-funds";
import { CommitFundsParams } from "../lib/params";
import { DBStatus } from "../../shared/prisma-schemas";

const MAX_UTXOS_PER_COMMIT = 10;

async function handleOpenHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema
): Promise<{ operationId: string }> {
  const { auth_token } = params;
  const {
    ADMIN_NODE_WS_URL: wsUrl,
  } = env;
  try {
    if (!validateAdmin(auth_token)) {
      throw new Error("Unauthorized");
    }
    const localLucid = _.cloneDeep(lucid);
    localLucid.selectWallet.fromSeed(env.SEED);

    // Step 1: Initialize the head
    logger.info("Initializing head...");
    const hydra = new HydraHandler(localLucid, wsUrl);
    const initTag = await hydra.init();
    if (initTag !== "HeadIsInitializing") {
      logger.error(initTag);
    }
    const newProcess = await prisma.process
      .create({
        data: {
          status: DBStatus.INITIALIZING,
        },
      })
      .catch((error) => {
        logger.error("DB Error while opening head: " + error);
        throw error;
      });
    await hydra.stop();
    return { operationId: newProcess.id };
  } catch (error) {
    logger.error("Error while initializing head");
    throw error;
  }
}

async function finalizeOpenHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema,
  processId: string
) {
  const localLucid = _.cloneDeep(lucid);
  const { peer_api_urls: peerUrls } = params;
  const { ADMIN_ADDRESS: adminAddress, VALIDATOR_REF: vRef } = env;
  try {
    const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
    // Step 2: Lookup deposit UTxOs in L1 and merge them for each user
    const [validatorRef] = await localLucid.utxosByOutRef([
      { txHash: vRef, outputIndex: 0 },
    ]);
    const validator = getValidator(validatorRef);
    const scriptAddress = validatorToAddress(
      localLucid.config().network,
      validator
    );
    const maxScriptUtxos = MAX_UTXOS_PER_COMMIT * peerUrls.length;
    const scriptUtxos = await localLucid
      .utxosAt(scriptAddress)
      .then((utxos) => utxos.slice(0, maxScriptUtxos));
    if (scriptUtxos.length === 0) {
      throw new Error("No deposits to commit");
    }
    const userToDepositsMap = new Map<string, UTxO[]>();
    for (const utxo of scriptUtxos) {
      const { addr } = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
      const userAddress = dataAddressToBech32(localLucid, addr);
      if (!userToDepositsMap.has(userAddress)) {
        userToDepositsMap.set(userAddress, []);
      }
      userToDepositsMap.get(userAddress)!.push(utxo);
    }
    let currentAdminUtxos = await localLucid
      .utxosAt(adminAddress)
      .then((utxos) =>
        selectUTxOs(utxos, {
          ["lovelace"]: BigInt(userToDepositsMap.size * 1_000_000 + 10_000_000),
        })
      );
    if (currentAdminUtxos.length === 0) {
      throw new Error("Insufficient admin funds");
    }
    let mergeTxs: string[] = [];
    let fundsRefs: OutRef[] = [];
    // logger.info("Preparing merge transactions...");
    // for (const [_, deposits] of userToDepositsMap) {
    //   if (deposits.length === 1) {
    //     // User has only one funds utxo, no need for a merge transaction
    //     const { txHash, outputIndex } = deposits[0];
    //     fundsRefs.push({ txHash, outputIndex });
    //     continue;
    //   }
    //   const params = {
    //     adminAddress,
    //     userFundsUtxos: deposits,
    //     adminUtxos: currentAdminUtxos,
    //     validatorRef: validatorRef,
    //   };
    //   const { tx, newFundsUtxo, newAdminUtxos } = await mergeFunds(
    //     localLucid,
    //     params
    //   );
    //   const signedTx = await tx.sign
    //     .withWallet()
    //     .complete()
    //     .then((tx) => tx.toCBOR());
    //   fundsRefs.push(newFundsUtxo);
    //   mergeTxs.push(signedTx);
    //   currentAdminUtxos = newAdminUtxos;
    // }
    // if (mergeTxs.length > 0) {
    //   const merge = await prisma.process
    //     .upsert({
    //       where: { id: processId },
    //       update: {
    //         status: Status.MERGING,
    //       },
    //       create: {
    //         id: processId,
    //         kind: Kind.OPEN_HEAD,
    //         status: Status.MERGING,
    //       },
    //     })
    //     .catch((error) => {
    //       logger.error(
    //         "DB Error while updating status to merging funds: " + error
    //       );
    //       throw error;
    //     });
    //   logger.info("Submitting merge transactions...");
    //   for (const tx of mergeTxs) {
    //     const txid = await localLucid.wallet().submitTx(tx);
    //     logger.info(
    //       `Merge transaction submitted! tx id: https://preprod.cexplorer.io/tx/${txid}`
    //     );
    //   }
    //   const lastSubmittedTxHash = localLucid
    //     .fromTx(mergeTxs[mergeTxs.length - 1])
    //     .toHash();
    //   logger.info(
    //     "Merge transactions submitted succesfully, last tx: " +
    //       lastSubmittedTxHash
    //   );
    //   await waitForUtxosUpdate(localLucid, adminAddress, lastSubmittedTxHash);
    // }

    // Step 3: Commit the funds
    const adminUtxos = await localLucid
      .utxosAt(adminAddress)
      .then((utxos) =>
        utxos.filter((utxo) => Object.entries(utxo.assets).length === 1)
      );
    const adminCollateral = adminUtxos[0];
    const utxosToCommit = scriptUtxos.slice(0,2);//await localLucid.utxosByOutRef(fundsRefs);
    const utxosPerPeer = 1 + utxosToCommit.length / peerUrls.length;
    const commit = await prisma.process
      .upsert({
        where: { id: processId },
        update: {
          status: DBStatus.COMMITTING,
        },
        create: {
          id: processId,
          status: DBStatus.COMMITTING,
        },
      })
      .catch((error) => {
        logger.error(
          "DB Error while updating status to committing funds: " + error
        );
        throw error;
      });
    for (let i = 0; i < peerUrls.length; i++) {
      const peerUrl = peerUrls[i];
      const thisPeerUtxos = utxosToCommit.slice(0, utxosPerPeer);
      utxosToCommit.splice(0, utxosPerPeer);
      let params: CommitFundsParams = {
        adminAddress,
        userFundUtxos: thisPeerUtxos,
        validatorRefUtxo: validatorRef,
      };
      // Add admin collateral to the last commit tx
      if (i === peerUrls.length - 1) {
        params = { ...params, adminCollateral };
      }
      const { tx } = await commitFunds(localLucid, params);
      const peerCommitTxId = await hydra.sendCommit(
        peerUrl,
        tx.toCBOR(),
        thisPeerUtxos
      );
      logger.info(`Commit transaction submitted! tx id: ${peerCommitTxId}`);
      let commitTag = "";
      logger.info("Waiting for last commit to be confirmed by the hydra node");
      while (commitTag !== "Committed") {
        commitTag = await hydra.listen("Committed");
      }
    }
    logger.info("All funds committed successfully");
    const awaiting = await prisma.process
      .upsert({
        where: { id: processId },
        update: {
          status: DBStatus.AWAITING,
        },
        create: {
          id: processId,
          status: DBStatus.AWAITING,
        },
      })
      .catch((error) => {
        logger.error("DB Error while updating status to awaiting: " + error);
        throw error;
      });

    let openHeadTag = "";
    while (openHeadTag !== "HeadIsOpen") {
      logger.info("Head not opened yet");
      openHeadTag = await hydra.listen("HeadIsOpen");
    }
    await prisma.process
      .upsert({
        where: { id: processId },
        update: {
          status: DBStatus.RUNNING,
        },
        create: {
          id: processId,
          status: DBStatus.RUNNING,
        },
      })
      .catch((error) => {
        logger.error("DB Error while updating status to completed: " + error);
        throw error;
      });
    await hydra.stop();
    return;
  } catch (error) {
    logger.error("Error while opening head, aborting...");
    await prisma.process
      .upsert({
        where: { id: processId },
        update: {
          status: DBStatus.FAILED,
        },
        create: {
          id: processId,
          status: DBStatus.FAILED,
        },
      })
      .catch((error) => {
        logger.error("DB Error while updating status to failed: " + error);
        throw error;
      });
      const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
      await hydra.abort();
      await hydra.listen("HeadIsAborted");
      await hydra.stop();
    throw error;
  }
}

function validateAdmin(auth_token: string): boolean {
  return true;
}

export { handleOpenHead, finalizeOpenHead };
