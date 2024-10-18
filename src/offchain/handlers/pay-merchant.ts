import { LucidEvolution, OutRef, UTxO } from "@lucid-evolution/lucid";
import { PayMerchantParams } from "../lib/params";
import { PayMerchantSchema } from "../../shared";
import { payMerchant } from "../tx-builders/pay";
import { TxBuiltResponse } from "../../api/schemas/response";
import { env } from "../../config";
import { logger } from "../../logger";
import _ from "lodash";

async function handlePay(
  lucid: LucidEvolution,
  params: PayMerchantSchema
): Promise<TxBuiltResponse & { merchUtxo: OutRef }> {
  try {
    // TODO here lucid needs instantiation with the correct network
    const localLucid = _.cloneDeep(lucid);
    const {
      user_address: userAddress,
      merchant_address: merchantAddress,
      funds_utxo_ref,
      amount: amountToPay,
      signature,
      merchant_funds_utxo,
    } = params;
    const { ADMIN_KEY: adminKey, HYDRA_KEY: hydraKey } = env;
    let fundsUtxo,
      merchantFundsUtxo: UTxO | undefined = undefined;
    if (funds_utxo_ref) {
      const { hash: txHash, index: outputIndex } = funds_utxo_ref;
      [fundsUtxo] = await localLucid.utxosByOutRef([{ txHash, outputIndex }]);
    }
    if (!fundsUtxo) {
      throw new Error(`User funds utxo not found`);
    }
    if (merchant_funds_utxo) {
      const { hash: txHash, index: outputIndex } = merchant_funds_utxo;
      const [merchantFundsUtxo] = await localLucid.utxosByOutRef([
        { txHash, outputIndex },
      ]);
      if (!merchantFundsUtxo) {
        throw new Error(`Merchant funds utxo not found`);
      }
    }

    const payMerchantParams: PayMerchantParams = {
      userAddress,
      merchantAddress,
      amountToPay,
      userFundsUtxo: fundsUtxo,
      signature,
      adminKey,
      hydraKey,
      merchantFundsUtxo,
    };
    const { tx, userUtxo, merchantUtxo } = await payMerchant(
      localLucid,
      payMerchantParams
    );

    return {
      cborHex: tx.toCBOR(),
      fundsUtxoRef: userUtxo,
      merchUtxo: merchantUtxo,
    };
  } catch (e) {
    if (e instanceof Error) {
      logger.error("500 /deposit - " + e.message);
    } else if (typeof e === "string" && e.includes("InputsExhaustedError")) {
      logger.error("400 /deposit - " + e);
    } else {
      logger.error("520 /deposit - Unknown error type");
      logger.error(JSON.stringify(e));
    }
    throw e;
  }
}

export { handlePay };
