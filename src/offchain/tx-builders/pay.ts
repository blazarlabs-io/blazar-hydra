import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";

async function payMerchant(
  lucid: LucidEvolution
): Promise<TxSignBuilder> {
  const tx = await lucid
    .newTx()
    .complete();
  return tx;
}

export { payMerchant };