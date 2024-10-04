import { DepositSchema } from "../../shared";
import { deposit } from "../tx-builders/deposit";
import { CBORHex, LucidEvolution, UTxO } from "@lucid-evolution/lucid";

async function handleDeposit(
  lucid: LucidEvolution,
  params: DepositSchema
): Promise<CBORHex> {
  const {
    user_address: userAddress,
    amount: amountToDeposit,
    funds_utxo_ref,
  } = params;
  let fundsUtxo: UTxO | undefined = undefined;
  if (funds_utxo_ref) {
    [fundsUtxo] = await lucid.utxosByOutRef([funds_utxo_ref]);
  }
  const depositParams = { userAddress, amountToDeposit, fundsUtxo };
  const unbTx = await deposit(lucid, depositParams);
  return unbTx.toCBOR();
}

export { handleDeposit };
