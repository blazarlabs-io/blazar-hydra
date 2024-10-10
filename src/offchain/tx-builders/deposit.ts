import {
  Data,
  fromText,
  getAddressDetails,
  LucidEvolution,
  toUnit,
  TxSignBuilder,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { DepositParams } from "../lib/params";
import { Spend, Mint, OutputRefT, FundsDatumT } from "../lib/types";
import { bech32ToAddressType } from "../lib/utils";

async function deposit(
  lucid: LucidEvolution,
  params: DepositParams
): Promise<TxSignBuilder> {
  const tx = lucid.newTx();
  const {
    userAddress,
    amountToDeposit,
    walletUtxos,
    validatorRef,
    fundsUtxo,
  } = params;

  // Script UTxO related boilerplate
  const validator = validatorRef.scriptRef;
  if (!validator) {
    throw new Error("Invalid validator reference");
  }
  const scriptAddress = validatorToAddress(lucid.config().network, validator);
  const policyId = getAddressDetails(scriptAddress).paymentCredential?.hash;
  if (!policyId) {
    throw new Error("Invalid script address");
  }
  const validationToken = toUnit(policyId, fromText("validation_token"));

  // Build the transaction
  const minLvc = 2_000_000n;
  let totalAmount = amountToDeposit;
  if (fundsUtxo) {
    tx.collectFrom([fundsUtxo], Spend.AddFunds);
    // Add the funds from the input UTxO, including the locked_deposit
    totalAmount += fundsUtxo.assets["lovelace"];
  } else {
    const outRef: OutputRefT = {
      transaction_id: { hash: walletUtxos[0].txHash },
      output_index: 0n,
    };
    tx.mintAssets({ [validationToken]: 1n }, Mint.Mint(outRef));
    totalAmount += minLvc;
  }
  const datum = Data.to<FundsDatumT>({
    addr: bech32ToAddressType(lucid, userAddress),
    locked_deposit: minLvc,
    funds_type: "User",
  });

  const txSignBuilder = tx
    .readFrom([validatorRef])
    .collectFrom(walletUtxos)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      { ["lovelace"]: totalAmount, [validationToken]: 1n }
    )
    .complete();
  return txSignBuilder;
}

export { deposit };
