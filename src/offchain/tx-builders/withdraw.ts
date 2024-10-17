import {
  Data,
  fromUnit,
  getAddressDetails,
  LucidEvolution,
  Script,
  TxSignBuilder,
  UTxO,
  validatorToAddress,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { WithdrawParams } from "../lib/params";
import { Combined, FundsDatum, FundsDatumT, Mint, Spend } from "../lib/types";
import { buildValidator } from "../validator/handle";
import { dataAddressToBech32 } from "../lib/utils";

async function withdraw(
  lucid: LucidEvolution,
  params: WithdrawParams
): Promise<{ tx: TxSignBuilder }> {
  const tx = lucid.newTx();
  const {
    kind,
    fundsUtxos,
    signature,
    adminKey,
    hydraKey,
    validatorRef,
    walletUtxos,
  } = params;

  // Script UTxO related boilerplate
  const validator = getValidator(validatorRef, adminKey, hydraKey);
  const scriptAddress = validatorToAddress(lucid.config().network, validator);
  const policyId = getAddressDetails(scriptAddress).paymentCredential?.hash;
  if (!policyId) {
    throw new Error("Invalid script address");
  }
  const sortedInputs = fundsUtxos.sort((a, b) => {
    const ref1 = {hash: a.txHash, index: a.outputIndex};
    const ref2 = {hash: b.txHash, index: b.outputIndex};
    const hashComparison = ref1.hash.localeCompare(ref2.hash);
    return hashComparison !== 0 ? hashComparison : ref1.index - ref2.index;
  });

  for (let i = 0; i < sortedInputs.length; i++) {
    // Build transaction values and datums
    const fundsUtxo = sortedInputs[i];
    if (!fundsUtxo.datum) {
      throw new Error("Funds UTxO datum not found");
    }
    const datum = Data.from<FundsDatumT>(fundsUtxo.datum, FundsDatum);
    const address = dataAddressToBech32(lucid, datum.addr);
    const totalFunds = fundsUtxo.assets["lovelace"];
    const validationToken = Object.keys(fundsUtxo.assets).find(
      (asset) => fromUnit(asset).policyId === policyId
    );
    if (!validationToken) {
      throw new Error("Validation token not found in funds UTxO");
    }
    const withdrawInfo = {
      sig: signature,
      ref: {
        transaction_id: { hash: fundsUtxo.txHash },
        output_index: BigInt(fundsUtxo.outputIndex),
      },
    };
    const redeemer =
      kind === "merchant"
        ? Spend.MerchantWithdraw
        : Spend.UserWithdraw(withdrawInfo);

    tx.collectFrom([fundsUtxo], redeemer);
    tx.mintAssets({ [validationToken]: -1n }, Mint.Burn);
    tx.pay.ToAddress(address, { ["lovelace"]: totalFunds });
  }

  // Complete transaction
  if (walletUtxos) {
    tx.collectFrom(walletUtxos);
  }
  if (kind === "user") {
    tx.readFrom([validatorRef!]);
  } else {
    // Transaction is submitted only in L2, so we include the validator in the transaction
    tx.attach.WithdrawalValidator(validator);
  }

  const rewardAddress = validatorToRewardAddress(lucid.config().network, validator);
  const txSignBuilder = await tx
    .withdraw(rewardAddress, 0n, Combined.CombinedWithdraw)
    .complete();

  return { tx: txSignBuilder };
}

function getValidator(
  validatorRef: UTxO | undefined,
  adminKey: string | undefined,
  hydraKey: string | undefined
): Script {
  if (!validatorRef || !(adminKey && hydraKey)) {
    throw new Error("Must include validator reference or validator parameters");
  }
  if (validatorRef) {
    if (!validatorRef.scriptRef) {
      throw new Error("Validator script not found in UTxO");
    }
    return validatorRef.scriptRef;
  } else {
    const hydraCred = { Verification_key_cred: { Key: hydraKey } };
    return buildValidator(adminKey, hydraCred);
  }
}
export { withdraw };
