import { deposit } from "../tx-builders/deposit";
import { CBORHex, LucidEvolution } from "@lucid-evolution/lucid";

async function handleDeposit(
  lucid: LucidEvolution
): Promise<CBORHex> {
  const unbTx = await deposit(lucid);
  return unbTx.toCBOR();
}

export { handleDeposit };