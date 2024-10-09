import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { WithdrawParams } from "../params";

async function withdraw(
  lucid: LucidEvolution,
  params: WithdrawParams
): Promise<TxSignBuilder> {
  const tx = await lucid.newTx().complete();
  return tx;
}

export { withdraw };
