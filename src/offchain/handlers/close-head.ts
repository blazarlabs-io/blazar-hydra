import { Data, LucidEvolution } from "@lucid-evolution/lucid";
import { ManageHeadSchema } from "../../shared";
import { logger } from "../../logger";
import { HydraHandler } from "../lib/hydra";
import _ from "lodash";
import { env } from "../../config";
import { FundsDatum, FundsDatumT } from "../lib/types";
import { WithdrawParams } from "../lib/params";
import { withdraw } from "../tx-builders/withdraw";

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
      const datum = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
      return datum.funds_type === "Merchant";
    });
    if (merchantUtxos.length !== 0) {
      logger.info("Withdrawing merchant utxos...");
      const walletUtxos = await localLucid.utxosAt(adminAddress);
      const withdrawParams: WithdrawParams = {
        kind: "merchant",
        fundsUtxos: merchantUtxos,
        adminKey,
        hydraKey,
        walletUtxos,
      };
      const { tx } = await withdraw(localLucid, withdrawParams);
      const signedTx = await tx.sign
        .withWallet()
        .complete()
        .then((tx) => tx.toCBOR());
      while (currentExpectedTag !== "TxValid") {
        currentExpectedTag = await hydra.sendTx(signedTx);
        if (currentExpectedTag !== "TxValid") {
          throw new Error("Tx is not valid, retrying...");
        }
        _.delay(() => {}, 10000);
      }
    }

    // Step 2: Send close command
    logger.info("Closing head...");
    while (currentExpectedTag !== "HeadIsClosed") {
      currentExpectedTag = (await Promise.race([
        new Promise((resolve, _) =>
          setTimeout(() => {
            logger.error("Close command not received, retrying...");
            resolve("IncorrectTag");
          }, 40_000)
        ),
        hydra.close(),
      ])) as string;
      hydra.stop();
    }
    logger.info("Waiting for fanout tag...");
    while (currentExpectedTag !== "ReadyToFanout") {
      currentExpectedTag = await hydra.listen("ReadyToFanout");
    }

    // Step 3: Fanout
    logger.info("Sending fanout command...");
    await hydra.fanout();
    hydra.stop();
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
