import {
  CML,
  createCostModels,
  getAddressDetails,
  LucidEvolution,
  TxSignBuilder,
  utxoToCore,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { CommitFundsParams } from "../lib/params";
import { Combined, Spend } from "../lib/types";

async function commitFunds(
  lucid: LucidEvolution,
  params: CommitFundsParams
): Promise<{ tx: TxSignBuilder }> {
  const { adminAddress, userFundUtxos, validatorRefUtxo } = params;

  const validator = validatorRefUtxo.scriptRef;
  if (!validator) {
    throw new Error(`Validator not found at UTxO: ${validatorRefUtxo}`);
  }
  const rewardAddress = validatorToRewardAddress(
    lucid.config().network,
    validator
  );
  const sortedInputs = userFundUtxos.sort((a, b) => {
    const ref1 = { hash: a.txHash, index: a.outputIndex };
    const ref2 = { hash: b.txHash, index: b.outputIndex };
    const hashComparison = ref1.hash.localeCompare(ref2.hash);
    return hashComparison !== 0 ? hashComparison : ref1.index - ref2.index;
  });

  // Build Initial txbody
  const inputs = CML.TransactionInputList.new();
  sortedInputs.map((utxo) => {
    const cmlInput = utxoToCore(utxo).input();
    inputs.add(cmlInput);
  });
  const outputs = CML.TransactionOutputList.new();
  const fee = 0n;
  const txBody = CML.TransactionBody.new(inputs, outputs, fee);

  // Add required signers
  const adminKey = getAddressDetails(adminAddress).paymentCredential?.hash as string;
  const signer = CML.Ed25519KeyHash.from_hex(adminKey);
  const signers = CML.Ed25519KeyHashList.new();
  signers.add(signer);
  txBody.set_required_signers(signers);

  // Add withdrawal
  const rewAddress = CML.RewardAddress.from_address(
    CML.Address.from_bech32(rewardAddress)
  );
  if (!rewAddress) {
    throw new Error(`Could not build reward address from script`);
  }
  const withdrawMap = CML.MapRewardAccountToCoin.new();
  withdrawMap.insert(rewAddress, 0n);
  txBody.set_withdrawals(withdrawMap);

  // Create witness set
  const txWitnessSet = CML.TransactionWitnessSet.new();

  // Add spend redeemers
  const legacyRedeemers = CML.LegacyRedeemerList.new();
  sortedInputs.map((_, idx) => {
    const tag = CML.RedeemerTag.Spend;
    const index = BigInt(idx);
    const data = CML.PlutusData.from_cbor_hex(Spend.Commit);
    const units = CML.ExUnits.new(0n, 0n);
    legacyRedeemers.add(CML.LegacyRedeemer.new(tag, index, data, units));
  });
  // Add withdraw redeemer
  legacyRedeemers.add(
    CML.LegacyRedeemer.new(
      CML.RedeemerTag.Reward,
      0n,
      CML.PlutusData.from_cbor_hex(Combined.CombinedCommit),
      CML.ExUnits.new(0n, 0n)
    )
  );
  const redeemers = CML.Redeemers.new_arr_legacy_redeemer(legacyRedeemers);
  txWitnessSet.set_redeemers(redeemers);

  // Add plutus script
  const scripts = CML.PlutusV3ScriptList.new();
  const script = CML.PlutusV3Script.from_cbor_hex(validator.script);
  scripts.add(script);
  txWitnessSet.set_plutus_v3_scripts(scripts);

  const cmlTx = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();
  const tx = lucid.fromTx(cmlTx);

  return { tx };
}

export { commitFunds };
