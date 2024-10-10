
import { CBORHex, LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { PayMerchantParams } from "../lib/params";
import { PayMerchantSchema } from "../../shared";
import { payMerchant } from "../tx-builders/pay";

async function handlePay(
  lucid: LucidEvolution,
  params: PayMerchantSchema
): Promise<CBORHex> {
  const {
    user_address: userAddress,
    merchant_address: merchantAddress,
    funds_utxo_ref,
    amount: amountToPay,
    signature,
  } = params;
  let fundsUtxo: UTxO | undefined = undefined;
  if (funds_utxo_ref) {
    const { hash: txHash, index: outputIndex } = funds_utxo_ref;
    [fundsUtxo] = await lucid.utxosByOutRef([{ txHash, outputIndex }]);
  }
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
