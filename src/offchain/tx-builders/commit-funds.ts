import {
  CBORHex,
  CML,
  getAddressDetails,
  LucidEvolution,
  sortUTxOs,
  UTxO,
  utxoToCore,
} from '@lucid-evolution/lucid';
import { Combined, Spend } from '../lib/types';
import { getNetworkFromLucid, getValidatorDetails } from '../lib/utils';

/**
 * Parameters for building an incremental commit blueprint transaction.
 */
type IncrementalCommitBlueprintParams = {
  adminAddress: string;
  depositedUtxo: UTxO;
  validatorRefUtxo: UTxO;
};

/**
 * Builds a blueprint transaction for incremental commit (deposit) to an OPEN Hydra head.
 * This blueprint is required when committing script-locked UTxOs because Hydra needs
 * to know how to spend them (with proper redeemers and script references).
 *
 * In Hydra 2.x the head opens empty — every fund injection is an incremental deposit,
 * so we always use PartialCommit + CombinedPartialCommit redeemers and always reference
 * the on-L1 validator ref-script UTxO (VALIDATOR_REF is never consumed into the head).
 *
 * @param lucid - The LucidEvolution instance to use for building the transaction.
 * @param params - The parameters including deposited UTXO and validator reference.
 * @returns The blueprint transaction in CBORHex format.
 */
async function buildIncrementalCommitBlueprint(
  lucid: LucidEvolution,
  params: IncrementalCommitBlueprintParams
): Promise<CBORHex> {
  const { adminAddress, depositedUtxo, validatorRefUtxo } = params;

  const validator = validatorRefUtxo.scriptRef;
  if (!validator) {
    throw new Error(`Validator not found at UTxO: ${validatorRefUtxo.txHash}#${validatorRefUtxo.outputIndex}`);
  }

  const network = getNetworkFromLucid(lucid);
  const { scriptAddress, rewardAddress } = getValidatorDetails(validator, network);
  const adminKey = getAddressDetails(adminAddress).paymentCredential?.hash as string;

  // Sort inputs (only the deposited UTXO for incremental commit)
  const sortedInputs = sortUTxOs([depositedUtxo], 'Canonical');

  // Build transaction body
  const inputs = CML.TransactionInputList.new();
  sortedInputs.forEach((utxo) => {
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

  // Create witness set with redeemers
  const txWitnessSet = CML.TransactionWitnessSet.new();
  const conwayRedeemers = CML.MapRedeemerKeyToRedeemerVal.new();

  // Always use PartialCommit — every deposit is incremental in Hydra 2.x
  const spendRedeemer = Spend.PartialCommit;

  sortedInputs.forEach((inp, idx) => {
    if (inp.address === scriptAddress) {
      const tag = CML.RedeemerTag.Spend;
      const index = BigInt(idx);
      const data = CML.PlutusData.from_cbor_hex(spendRedeemer);
      const units = CML.ExUnits.new(0n, 0n);
      conwayRedeemers.insert(
        CML.RedeemerKey.new(tag, index),
        CML.RedeemerVal.new(data, units)
      );
    }
  });

  // Add withdrawal - ALWAYS required by the on-chain script
  // The on-chain validator calls check_withdraw_is_present() which expects a withdrawal redeemer
  const rewAddress = CML.RewardAddress.from_address(
    CML.Address.from_bech32(rewardAddress)
  );
  if (!rewAddress) {
    throw new Error('Could not build reward address from script');
  }
  const withdrawMap = CML.MapRewardAccountToCoin.new();
  withdrawMap.insert(rewAddress, 0n);
  txBody.set_withdrawals(withdrawMap);

  // Always use CombinedPartialCommit — only requires admin signature (no Hydra head input check)
  const withdrawRedeemer = Combined.CombinedPartialCommit;

  conwayRedeemers.insert(
    CML.RedeemerKey.new(CML.RedeemerTag.Reward, 0n),
    CML.RedeemerVal.new(
      CML.PlutusData.from_cbor_hex(withdrawRedeemer),
      CML.ExUnits.new(0n, 0n)
    )
  );

  // Always reference the on-L1 validator ref-script UTxO (head opens empty in 2.x;
  // VALIDATOR_REF is never consumed into the head).
  const referenceInputs = CML.TransactionInputList.new();
  referenceInputs.add(utxoToCore(validatorRefUtxo).input());
  txBody.set_reference_inputs(referenceInputs);

  // Add redeemers to witness set
  const redeemers = CML.Redeemers.new_map_redeemer_key_to_redeemer_val(conwayRedeemers);
  txWitnessSet.set_redeemers(redeemers);

  const cbor = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();

  return cbor;
}

export { buildIncrementalCommitBlueprint, IncrementalCommitBlueprintParams };
