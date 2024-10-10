import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { CommitFundsParams } from "../lib/params";

async function commitFunds(
  lucid: LucidEvolution,
  params: CommitFundsParams
): Promise<TxSignBuilder> {
  const tx = await lucid.newTx().complete();
  return tx;
}

export { commitFunds };
