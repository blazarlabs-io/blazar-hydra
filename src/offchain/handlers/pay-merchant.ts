
import { CBORHex, LucidEvolution } from "@lucid-evolution/lucid";
import { PayMerchantParams } from "../types";
import { PayMerchantSchema } from "../../shared";
import { payMerchant } from "../tx-builders/pay";

async function handlePay(
  lucid: LucidEvolution,
  params: PayMerchantSchema
): Promise<CBORHex> {
  const {
    user_address: userAddress,
    merchant_address: merchantAddress,
    funds_utxo_ref: fundsUtxoRef,
    amount: amountToPay,
    signature,
  } = params;
  const [fundsUtxo] = await lucid.utxosByOutRef([fundsUtxoRef]);
  if (!fundsUtxo) {
    throw new Error(`Funds utxo not found`);
  }
  const payMerchantParams: PayMerchantParams = {
    userAddress,
    merchantAddress,
    amountToPay,
    fundsUtxo,
    signature,
  };
  const unbTx = await payMerchant(lucid, payMerchantParams);
  return unbTx.toCBOR();
}

export { handlePay };
