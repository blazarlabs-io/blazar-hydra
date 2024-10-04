import { addAssets, LucidEvolution } from "@lucid-evolution/lucid";
import { QueryFundsResponse } from "../../api/schemas/response";

async function handleQueryFunds(
  lucid: LucidEvolution,
  address: string,
): Promise<QueryFundsResponse> {
  const funds = {
    adaInL1: 0n,
    adaInL2: 0n,
  }
  return funds;
}

export { handleQueryFunds };