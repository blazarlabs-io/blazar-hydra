import {
  Data,
  fromUnit,
  getAddressDetails,
  LucidEvolution,
  OutRef,
  TxSignBuilder,
  validatorToAddress,
} from "@lucid-evolution/lucid";
import { WithdrawParams } from "../lib/params";
import { FundsDatum, FundsDatumT, Mint, Spend } from "../lib/types";

async function withdraw(
  lucid: LucidEvolution,
  params: WithdrawParams
): Promise<{ tx: TxSignBuilder; newFundsUtxo: OutRef }> {
  const tx = lucid.newTx();
  const {
    address,
    fundsUtxo,
    signature,
    validatorRef,
    walletUtxos,
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

  // Build transaction values and datums
  if (!fundsUtxo.datum) {
    throw new Error("Funds UTxO datum not found");
  }
  const totalFunds = fundsUtxo.assets["lovelace"];
  const validationToken = Object.keys(fundsUtxo.assets).find(
    (asset) => fromUnit(asset).policyId === policyId
  ) as string;
  const withdrawInfo = {
    sig: signature,
    ref: {
      transaction_id: { hash: fundsUtxo.txHash },
      output_index: BigInt(fundsUtxo.outputIndex),
    },
  };

  // Build transaction
  if (walletUtxos) {
    tx.collectFrom(walletUtxos);
  }
  const txSignBuilder = await tx
    .readFrom([validatorRef])
    .collectFrom([fundsUtxo], Spend.UserWithdraw(withdrawInfo))
    .mintAssets({[validationToken]: -1n}, Mint.Burn)
    .pay.ToAddress(address, { ["lovelace"]: totalFunds })
    .complete();

  const newFundsUtxo = {
    txHash: txSignBuilder.toHash(),
    outputIndex: 1,
  };
  return { tx: txSignBuilder, newFundsUtxo };
}

export { withdraw };
