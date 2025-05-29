import { Data, LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { ManageHeadSchema } from "../../shared";
import { logger } from "../../logger";
import { HydraHandler } from "../lib/hydra";
import _ from "lodash";
import { env, prisma } from "../../config";
import { FundsDatum, FundsDatumT } from "../lib/types";
import { WithdrawParams } from "../lib/params";
import { withdrawMerchant } from "../tx-builders/withdraw-merchant";
import { DBOps } from "../../prisma/db-ops";
import { DBStatus } from "../../shared/prisma-schemas";

const MAX_UTXOS_PER_DECOMMIT = 15;

/**
 * Starts the process of closing a Hydra head. It updates the head status to DECOMMITING in the database.
 */
async function handleCloseHead(
  params: ManageHeadSchema,
  processId: string,
): Promise<{ status: string }> {
  try {
    const { auth_token } = params;
    if (!validateAdmin(auth_token)) {
      throw new Error("Unauthorized");
    }
    await DBOps.updateHeadStatus(processId, DBStatus.DECOMMITING);
    return { status: DBStatus.DECOMMITING };
  } catch (error) {
    logger.error("Error handling close head");
    throw error;
  }
}

/**
 * Finalizes the close head process by:
 * 1. Withdrawing merchant UTXOs from the Hydra head.
 * 2. Sending the close command to the Hydra head.
 * 3. Waiting for the fanout tag and clearing the Hydra head.
 * 5. Deleting the process from the database.
 * @returns
 */
async function finalizeCloseHead(lucid: LucidEvolution, processId: string) {
  try {
    const { ADMIN_KEY: adminKey, HYDRA_KEY: hydraKey } = env;
    const { ADMIN_ADDRESS: adminAddress, ADMIN_NODE_WS_URL: wsUrl } = env;
    const localLucid = _.cloneDeep(lucid);
    localLucid.selectWallet.fromSeed(env.SEED);
    const hydra = new HydraHandler(localLucid, wsUrl);

    // Step 1: Withdraw Merchant utxos
    const fundUtxos = await hydra.getSnapshot();
    const merchantUtxos = fundUtxos.filter((utxo) => {
      if (utxo.address !== adminAddress) {
        const datum = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
        return datum.funds_type === "Merchant";
      }
      return false;
    });
    await withdrawMerchantUtxos(
      hydra,
      localLucid,
      adminAddress,
      adminKey,
      hydraKey,
      merchantUtxos,
    );
    await DBOps.updateHeadStatus(processId, DBStatus.CLOSING);

    // Step 2: Send close command
    let currentExpectedTag = "";
    while (currentExpectedTag !== "HeadIsClosed") {
      currentExpectedTag = (await Promise.race([
        new Promise((resolve, _) =>
          setTimeout(() => {
            logger.error("Close command not sent, retrying...");
            resolve("IncorrectTag");
          }, 40_000),
        ),
        hydra.close(),
      ])) as string;
    }
    logger.info("Waiting for fanout tag...");
    while (currentExpectedTag !== "ReadyToFanout") {
      currentExpectedTag = await hydra.listen("ReadyToFanout");
    }

    // Step 3: Fanout
    await hydra.fanout();
    await prisma.process.delete({ where: { id: processId } });
    await hydra.stop();
    return { status: DBStatus.CLOSED };
  } catch (error) {
    logger.error("Error during close head");
    throw error;
  }
}

function validateAdmin(auth_token: string): boolean {
  return true;
}

/**
 * Withdraws merchant UTXOs from the Hydra head.
 * It decommits the UTXOs in rounds, with a maximum of MAX_UTXOS_PER_DECOMMIT per round.
 * Waits for the decommit finalization tag to ensure the decommit was successful.
 */
async function withdrawMerchantUtxos(
  hydra: HydraHandler,
  lucid: LucidEvolution,
  adminAddress: string,
  adminKey: string,
  hydraKey: string,
  merchantUtxos: UTxO[],
) {
  let currentExpectedTag = "";
  if (merchantUtxos.length !== 0) {
    const roundsOfDecommit = Math.ceil(
      merchantUtxos.length / MAX_UTXOS_PER_DECOMMIT,
    );
    logger.info(roundsOfDecommit + " rounds of decommit");
    logger.info(merchantUtxos.length + " merchant utxos to withdraw");
    logger.info("Withdrawing merchant utxos...");
    const utxosInL2 = await hydra.getSnapshot();
    const walletUtxos = utxosInL2.filter((utxo) => {
      return utxo.address === adminAddress;
    });
    let thisRoundUtxos = [];
    for (let i = 0; i < roundsOfDecommit; i++) {
      logger.info(`Sending decommit ${i + 1} of ${roundsOfDecommit}`);
      thisRoundUtxos = merchantUtxos.slice(0, MAX_UTXOS_PER_DECOMMIT);
      merchantUtxos.splice(0, MAX_UTXOS_PER_DECOMMIT);
      const withdrawParams: WithdrawParams = {
        kind: "merchant",
        fundsUtxos: thisRoundUtxos,
        adminKey,
        hydraKey,
        walletUtxos,
      };
      const { tx } = await withdrawMerchant(lucid, withdrawParams);
      const signedTx = await tx.sign
        .withWallet()
        .complete()
        .then((tx) => tx.toCBOR());
      await hydra.decommit(`${env.ADMIN_NODE_API_URL}/decommit`, signedTx);
      currentExpectedTag = "NotDecommitFinalized";
      while (currentExpectedTag !== "DecommitFinalized") {
        currentExpectedTag = await hydra.listen("DecommitFinalized");
        if (currentExpectedTag === "DecommitInvalid") {
          throw new Error("Decommit rejected by Hydra node");
        }
      }
      logger.info("Decommit finalized.");
    }
  }
}

export { handleCloseHead, finalizeCloseHead };
