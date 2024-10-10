import {
  addAssets,
  Data,
  fromText,
  fromUnit,
  getAddressDetails,
  LucidEvolution,
  OutRef,
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
): Promise<{tx: TxSignBuilder, newFundsUtxo: OutRef}> {
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

  // Build the transaction
  const minLvc = 2_000_000n;
  let totalAmount = amountToDeposit;
  let validationToken = "";
  if (fundsUtxo) {
    validationToken = Object.keys(fundsUtxo.assets).find(
      (asset) => fromUnit(asset).policyId === policyId
    ) as string;
    // Add the funds from the input UTxO, including the locked_deposit
    totalAmount +=  fundsUtxo.assets["lovelace"];
    tx.collectFrom([fundsUtxo], Spend.AddFunds);
  } else {
    const selectedUtxo = walletUtxos[0];
    const outRef: OutputRefT = {
      transaction_id: { hash: selectedUtxo.txHash },
      output_index: BigInt(selectedUtxo.outputIndex),
    };
    const serializedIndex = Data.to<bigint>(outRef.output_index);
    const newTokenName = selectedUtxo.txHash + serializedIndex;
    validationToken = toUnit(policyId, newTokenName);
    totalAmount += minLvc;
    tx.mintAssets({ [validationToken]: 1n }, Mint.Mint(outRef));
  }
  const datum = Data.to<FundsDatumT>({
    addr: bech32ToAddressType(lucid, userAddress),
    locked_deposit: minLvc,
    funds_type: "User",
  });

  const txSignBuilder = await tx
    .readFrom([validatorRef])
    .collectFrom(walletUtxos)
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: datum },
      { ["lovelace"]: totalAmount, [validationToken]: 1n }
    )
    .complete();

  const newFundsUtxo = {
    txHash: txSignBuilder.toHash(),
    outputIndex: 0,
  };

  return {tx: txSignBuilder, newFundsUtxo};
}

export { deposit };
