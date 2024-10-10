import { DepositSchema } from "../../shared";
import { DepositParams } from "../lib/params";
import { deposit } from "../tx-builders/deposit";
import {
  CBORHex,
  LucidEvolution,
  selectUTxOs,
  UTxO,
} from "@lucid-evolution/lucid";
import { env } from "../../config";

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
    const { hash: txHash, index: outputIndex } = funds_utxo_ref;
    [fundsUtxo] = await lucid.utxosByOutRef([{ txHash, outputIndex }]);
  }
  const walletUtxos = await lucid
    .utxosAt(userAddress)
    .then((utxos) => selectUTxOs(utxos, { lovelace: amountToDeposit }));
  const [validatorRef] = await lucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);
  const depositParams: DepositParams = {
    userAddress,
    amountToDeposit,
    walletUtxos,
    validatorRef,
    fundsUtxo,
  };
  const unsignedTx = await deposit(lucid, depositParams);
  return unsignedTx.toCBOR();
}

export { handleDeposit };
