import {
  addAssets,
  Assets,
  Data,
  getAddressDetails,
  LucidEvolution,
  OutRef,
  toUnit,
  TxSignBuilder,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { PayMerchantParams } from "../lib/params";
import { buildValidator } from "../validator/handle";
import {
  FundsDatum,
  FundsDatumT,
  Mint,
  OutputRefT,
  PayInfoT,
  Spend,
} from "../lib/types";
import { bech32ToAddressType } from "../lib/utils";

async function payMerchant(
  lucid: LucidEvolution,
  params: PayMerchantParams
): Promise<{ tx: TxSignBuilder; userUtxo: OutRef; merchantUtxo: OutRef }> {
  const tx = lucid.newTx();
  const {
    userFundsUtxo,
    merchantAddress,
    amountToPay,
    signature,
    adminKey,
    hydraKey,
    merchantFundsUtxo,
  } = params;

  // Script UTxO related boilerplate
  const hydraCred = { Verification_key_cred: { Key: hydraKey } };
  const validator = buildValidator(adminKey, hydraCred);
  if (!validator) {
    throw new Error("Invalid validator reference");
  }
  const scriptAddress = validatorToAddress(lucid.config().network, validator);
  const policyId = getAddressDetails(scriptAddress).paymentCredential?.hash;
  if (!policyId) {
    throw new Error("Invalid script address");
  }

  // Build values and datums
  const userRef: OutputRefT = {
    transaction_id: {
      hash: userFundsUtxo.txHash,
    },
    output_index: BigInt(userFundsUtxo.outputIndex),
  };
  let newMerchValue: Assets = { lovelace: amountToPay };
  let merchDatum: FundsDatumT;
  if (merchantFundsUtxo) {
    // Adding funds to an existing merchant UTxO
    tx.collectFrom([merchantFundsUtxo], Spend.AddFunds);
    newMerchValue = addAssets(newMerchValue, merchantFundsUtxo.assets);
    if (!merchantFundsUtxo.datum) {
      throw new Error("Merchant UTxO datum not found");
    }
    merchDatum = Data.from<FundsDatumT>(merchantFundsUtxo.datum, FundsDatum);
  } else {
    // Creating a new merchant UTxO
    const serializedIndex = Data.to<bigint>(userRef.output_index);
    const newTokenName = userFundsUtxo.txHash + serializedIndex;
    const validationToken = toUnit(policyId, newTokenName);
    tx.mintAssets({ [validationToken]: 1n }, Mint.Mint(userRef));
    newMerchValue[validationToken] = 1n;
    merchDatum = {
      addr: bech32ToAddressType(lucid, merchantAddress),
      locked_deposit: 0n,
      funds_type: "Merchant",
    };
  }
  if (!userFundsUtxo.datum) {
    throw new Error("User UTxO datum not found");
  }
  const userDatum = Data.from<FundsDatumT>(userFundsUtxo.datum, FundsDatum);
  if (
    amountToPay >
    userFundsUtxo.assets["lovelace"] - userDatum.locked_deposit
  ) {
    throw new Error("Amount to pay exceeds available funds");
  }
  const newUserValue = userFundsUtxo.assets["lovelace"] - amountToPay;
  const payInfo: PayInfoT = {
    amount: amountToPay,
    merchant_addr: bech32ToAddressType(lucid, merchantAddress),
    ref: userRef,
    sig: signature,
  };

  // Complete the transaction
  let txSignBuilder = await tx
    .collectFrom([userFundsUtxo], Spend.Pay(payInfo))
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: Data.to<FundsDatumT>(merchDatum, FundsDatum) },
      newMerchValue
    )
    .pay.ToContract(
      scriptAddress,
      { kind: "inline", value: userFundsUtxo.datum },
      { lovelace: newUserValue }
    )
    .attach.SpendingValidator(validator)
    .complete();

  const merchantUtxo = { txHash: txSignBuilder.toHash(), outputIndex: 0 };
  const userUtxo = { txHash: txSignBuilder.toHash(), outputIndex: 1 };
  return { tx: txSignBuilder, userUtxo, merchantUtxo };
}

export { payMerchant };
