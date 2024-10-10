import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { MergeFundsParams } from "../lib/params";

async function mergeFunds(
  lucid: LucidEvolution,
  params: MergeFundsParams
): Promise<TxSignBuilder> {
  const tx = await lucid.newTx().complete();
  return tx;
}

export { mergeFunds };
