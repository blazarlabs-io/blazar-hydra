import { withdraw } from "../tx-builders/withdraw";
import { CBORHex, LucidEvolution } from "@lucid-evolution/lucid";

async function handleWithdraw(
  lucid: LucidEvolution
): Promise<CBORHex> {
  const unbTx = await withdraw(lucid);
  return unbTx.toCBOR();
}

export { handleWithdraw };