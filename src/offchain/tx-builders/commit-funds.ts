import {
  CBORHex,
  CML,
  getAddressDetails,
  LucidEvolution,
  sortUTxOs,
  utxoToCore,
  validatorToAddress,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { CommitFundsParams } from "../lib/params";
import { Combined, Spend } from "../lib/types";
import { getNetworkFromLucid } from "../lib/utils";

/**
 * Builds a transaction to commit funds to a Hydra head. If there are no user funds to commit,
 * it returns undefined for the transaction, indicating the commit will be done without a blueprint tx.
 * @param lucid - The LucidEvolution instance to use for building the transaction.
 * @param params - The parameters for committing funds, including admin address, user fund UTxOs,
 * @returns An object containing the transaction in CBORHex format or undefined if no user funds are provided.
 */
async function commitFunds(
  lucid: LucidEvolution,
  params: CommitFundsParams
): Promise<{ tx: CBORHex | undefined }> {
  const { adminAddress, userFundUtxos, validatorRefUtxo, adminCollateral } =
    params;
  const validator = validatorRefUtxo.scriptRef;
  if (!validator) {
    throw new Error(`Validator not found at UTxO: ${validatorRefUtxo}`);
  }
  const network = getNetworkFromLucid(lucid);
  const scriptAddress = validatorToAddress(network, validator);
  const rewardAddress = validatorToRewardAddress(network, validator);
  const adminKey = getAddressDetails(adminAddress).paymentCredential
    ?.hash as string;

  if (userFundUtxos.length === 0) {
    // Commit with an empty blueprint tx
    return { tx: undefined };
  }

  let allInputs = userFundUtxos;
  if (adminCollateral) {
    allInputs.push(adminCollateral);
  }
  const sortedInputs = sortUTxOs(allInputs, "Canonical");

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
  const conwayRedeemers = CML.MapRedeemerKeyToRedeemerVal.new();
  sortedInputs.map((inp, idx) => {
    if (inp.address === scriptAddress) {
      const tag = CML.RedeemerTag.Spend;
      const index = BigInt(idx);
      const data = CML.PlutusData.from_cbor_hex(Spend.Commit);
      const units = CML.ExUnits.new(0n, 0n);
      conwayRedeemers.insert(
        CML.RedeemerKey.new(tag, index),
        CML.RedeemerVal.new(data, units)
      );
    }
  });

  // Add redeemers and validator only if there were script utxos being committed
  if (userFundUtxos.length > 0) {
    conwayRedeemers.insert(
      CML.RedeemerKey.new(CML.RedeemerTag.Reward, 0n),
      CML.RedeemerVal.new(
        CML.PlutusData.from_cbor_hex(Combined.CombinedCommit),
        CML.ExUnits.new(0n, 0n)
      )
    );
    const redeemers =
      CML.Redeemers.new_map_redeemer_key_to_redeemer_val(conwayRedeemers);
    txWitnessSet.set_redeemers(redeemers);

    // Add plutus script
    const scripts = CML.PlutusV3ScriptList.new();
    const script = CML.PlutusV3Script.from_cbor_hex(validator.script);
    scripts.add(script);
    txWitnessSet.set_plutus_v3_scripts(scripts);
  }

  const cbor = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();

  return { tx: cbor };
}

export { commitFunds };
