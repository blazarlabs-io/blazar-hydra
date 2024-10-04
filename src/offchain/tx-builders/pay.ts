import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { PayMerchantParams } from "../types";

async function payMerchant(
  lucid: LucidEvolution,
  params: PayMerchantParams
): Promise<TxSignBuilder> {
  const tx = await lucid.newTx().complete();
  return tx;
}

export { payMerchant };
