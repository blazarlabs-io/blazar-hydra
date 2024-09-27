import { payMerchant } from "../tx-builders/pay";
import { CBORHex, LucidEvolution } from "@lucid-evolution/lucid";

async function handlePay(
  lucid: LucidEvolution
): Promise<CBORHex> {
  const unbTx = await payMerchant(lucid);
  return unbTx.toCBOR();
}

export { handlePay };