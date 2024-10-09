import { LucidEvolution, TxSignBuilder } from "@lucid-evolution/lucid";
import { DepositParams } from "../params";

async function deposit(
  lucid: LucidEvolution,
  params: DepositParams
): Promise<TxSignBuilder> {
  const tx = await lucid.newTx().complete();
  return tx;
}

export { deposit };
