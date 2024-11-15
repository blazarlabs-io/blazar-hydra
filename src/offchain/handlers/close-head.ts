import { Data, LucidEvolution } from "@lucid-evolution/lucid";
import { ManageHeadSchema } from "../../shared";
import { logger } from "../../logger";
import { HydraHandler } from "../lib/hydra";
import _ from "lodash";
import { env } from "../../config";
import { FundsDatum, FundsDatumT } from "../lib/types";
import { WithdrawParams } from "../lib/params";
import { withdrawMerchant } from "../tx-builders/withdrawMerchant";

const MAX_UTXOS_PER_DECOMMIT = 15;

async function handleCloseHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema
): Promise<void> {
  try {
    const { auth_token } = params;
    const { ADMIN_KEY: adminKey, HYDRA_KEY: hydraKey } = env;
    if (!validateAdmin(auth_token)) {
      throw new Error("Unauthorized");
    }
    const { ADMIN_ADDRESS: adminAddress, ADMIN_NODE_WS_URL: wsUrl } = env;
    const localLucid = _.cloneDeep(lucid);
    localLucid.selectWallet.fromSeed(env.SEED);
    const hydra = new HydraHandler(localLucid, wsUrl);
    let currentExpectedTag = "";

    // Step 1: Withdraw Merchant utxos
    const fundUtxos = await hydra.getSnapshot();
    const merchantUtxos = fundUtxos.filter((utxo) => {
      if (utxo.address !== adminAddress) {
        const datum = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
        return datum.funds_type === "Merchant";
      }
      return false;
    });
    if (merchantUtxos.length !== 0) {
      const roundsOfDecommit = Math.ceil(merchantUtxos.length / MAX_UTXOS_PER_DECOMMIT);
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
        const { tx } = await withdrawMerchant(localLucid, withdrawParams);
        const signedTx = await tx.sign
          .withWallet()
          .complete()
          .then((tx) => tx.toCBOR());
        await hydra.decommit(
          `${env.ADMIN_NODE_API_URL}/decommit`,
          signedTx
        );
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

    // Step 2: Send close command
    while (currentExpectedTag !== "HeadIsClosed") {
      currentExpectedTag = (await Promise.race([
        new Promise((resolve, _) =>
          setTimeout(() => {
            logger.error("Close command not sent, retrying...");
            resolve("IncorrectTag");
          }, 40_000)
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
    await hydra.stop();
    return;
  } catch (error) {
    logger.error("Error during close head");
    throw error;
  }
}

function validateAdmin(auth_token: string): boolean {
  return true;
}

export { handleCloseHead };
