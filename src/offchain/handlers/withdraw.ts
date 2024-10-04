import { WithdrawSchema, Layer } from "../../shared";
import { withdraw } from "../tx-builders/withdraw";
import { CBORHex, LucidEvolution, UTxO } from "@lucid-evolution/lucid";
import { WithdrawParams } from "../types";

async function handleWithdraw(
  lucid: LucidEvolution,
  params: WithdrawSchema
): Promise<CBORHex> {
  const {
    address,
    amount: amountToWithdraw,
    funds_utxo_ref: fundsUtxoRef,
    signature,
    network_layer,
  } = params;
  if (network_layer === Layer.L1) {
    throw new Error("Unsupported network layer for operation");
  }
  const [fundsUtxo] = await lucid.utxosByOutRef([fundsUtxoRef]);
  if (!fundsUtxo) {
    throw new Error(`Funds utxo not found in ${network_layer.toString()}`);
  }
  const withdrawParams: WithdrawParams = {
    address,
    amountToWithdraw,
    fundsUtxo,
    signature,
  };
  const unbTx = await withdraw(lucid, withdrawParams);
  return unbTx.toCBOR();
}

export { handleWithdraw };
