import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";

async function deposit(
  lucid: LucidEvolution
): Promise<TxSignBuilder> {
  const tx = await lucid
    .newTx()
    .complete();
  return tx;
}

export { deposit };