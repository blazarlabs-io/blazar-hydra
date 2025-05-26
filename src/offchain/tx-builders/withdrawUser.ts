import {
  Data,
  fromUnit,
  getAddressDetails,
  LucidEvolution,
  TxSignBuilder,
  validatorToAddress,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { WithdrawParams } from "../lib/params";
import {
  Combined,
  FundsDatum,
  FundsDatumT,
  Mint,
  Spend,
  WithdrawInfoT,
} from "../lib/types";
import {
  dataAddressToBech32,
  getNetworkFromLucid,
  getValidator,
} from "../lib/utils";
import _ from "lodash";

async function withdraw(
  lucid: LucidEvolution,
  params: WithdrawParams,
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
  const network = getNetworkFromLucid(lucid);
  const scriptAddress = validatorToAddress(network, validator);
  const policyId = getAddressDetails(scriptAddress).paymentCredential?.hash;
  if (!policyId) {
    throw new Error("Invalid script address");
  }
  const sortedInputs = fundsUtxos.sort((a, b) => {
    const ref1 = { hash: a.txHash, index: a.outputIndex };
    const ref2 = { hash: b.txHash, index: b.outputIndex };
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
      (asset) => fromUnit(asset).policyId === policyId,
    );
    if (!validationToken) {
      throw new Error("Validation token not found in funds UTxO");
    }
    const withdrawInfo: WithdrawInfoT = {
      ref: {
        transaction_id: fundsUtxo.txHash,
        output_index: BigInt(fundsUtxo.outputIndex),
      },
    };
    const redeemer =
      kind === "merchant"
        ? Spend.MerchantWithdraw
        : Spend.UserWithdraw(withdrawInfo, signature!);

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

  const rewardAddress = validatorToRewardAddress(network, validator);
  const txSignBuilder = await tx
    .withdraw(rewardAddress, 0n, Combined.CombinedWithdraw)
    .attachMetadata(674, { msg: "HydraPay: Withdraw" })
    .complete();

  return { tx: txSignBuilder };
}

export { withdraw };
