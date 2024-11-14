import { LucidEvolution, OutRef, UTxO } from "@lucid-evolution/lucid";
import { PayMerchantParams } from "../lib/params";
import { PayMerchantSchema } from "../../shared";
import { payMerchant } from "../tx-builders/pay";
import { TxBuiltResponse } from "../../api/schemas/response";
import { env } from "../../config";
import { logger } from "../../logger";
import _ from "lodash";
import { HydraHandler } from "../lib/hydra";

async function handlePay(
  lucid: LucidEvolution,
  params: PayMerchantSchema
): Promise<{fundsUtxoRef: OutRef, merchUtxo: OutRef }> {
  try {
    const localLucid = _.cloneDeep(lucid);
    const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
    const {
      user_address: userAddress,
      merchant_address: merchantAddress,
      funds_utxo_ref,
      amount: amountToPay,
      signature,
      merchant_funds_utxo,
    } = params;
    const { ADMIN_KEY: adminKey, HYDRA_KEY: hydraKey } = env;
    let userFundsUtxo,
      merchantFundsUtxo: UTxO | undefined = undefined;
    const utxosInL2 = await hydra.getSnapshot();
    if (funds_utxo_ref) {
      const { hash: txHash, index: outputIndex } = funds_utxo_ref;
      userFundsUtxo = utxosInL2.find((utxo) => {
        return utxo.txHash === txHash && utxo.outputIndex === outputIndex;
      });
    }
    const adminCollateral = utxosInL2.find((utxo) => utxo.address === env.ADMIN_ADDRESS);
    if (!userFundsUtxo || !adminCollateral) {
      throw new Error(`User funds or collateral utxo not found`);
    }
    if (merchant_funds_utxo) {
      const { hash: txHash, index: outputIndex } = merchant_funds_utxo;
      const merchantFundsUtxo = utxosInL2.find((utxo) => {
        utxo.txHash === txHash && utxo.outputIndex === outputIndex;
      });
      if (!merchantFundsUtxo) {
        throw new Error(`Merchant funds utxo not found`);
      }
    }

    const payMerchantParams: PayMerchantParams = {
      adminCollateral,
      userAddress,
      merchantAddress,
      amountToPay,
      userFundsUtxo,
      signature,
      adminKey,
      hydraKey,
      merchantFundsUtxo,
    };
    const { tx, userUtxo, merchantUtxo } = await payMerchant(
      localLucid,
      payMerchantParams
    );

    logger.info("Submitting payment to hydra head...");
    lucid.selectWallet.fromSeed(env.SEED);
    const signedTx = await lucid.fromTx(tx.toCBOR()).sign.withWallet().complete();
    const tag = await hydra.sendTx(signedTx.toCBOR());
    if (tag !== "TxValid") {
      await hydra.stop()
      throw new Error(`Failed to submit payment tx to hydra head`);
    }
    await hydra.stop();

    return {
      fundsUtxoRef: userUtxo,
      merchUtxo: merchantUtxo,
    };
  } catch (e) {
    if (e instanceof Error) {
      logger.error("500 /pay - " + e.message);
    } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
      logger.error("400 /pay - " + e);
    } else {
      logger.error("520 /pay - Unknown error type");
      logger.error(JSON.stringify(e));
    }
    throw e;
  }
}

export { handlePay };
