import {
  CBORHex,
  CML,
  getAddressDetails,
  LucidEvolution,
  sortUTxOs,
  UTxO,
  utxoToCore,
} from '@lucid-evolution/lucid';
import { CommitFundsParams } from '../lib/params';
import { Combined, Spend } from '../lib/types';
import { getNetworkFromLucid, getValidatorDetails } from '../lib/utils';

/**
 * Parameters for building an incremental commit blueprint transaction.
 */
type IncrementalCommitBlueprintParams = {
  adminAddress: string;
  depositedUtxo: UTxO;
  validatorRefUtxo: UTxO;
  /** 
   * Whether to use the validator as a reference input (true) or include the script inline (false).
   * Set to false when the reference script UTXO has been committed to the head and no longer exists on L1.
   * Defaults to false for incremental commits.
   */
  useRefInput?: boolean;
  /**
   * Whether this is an incremental commit (deposit to OPEN head) or initial commit.
   * For incremental commits, uses PartialCommit + CombinedPartialCommit redeemers which
   * only require admin signature (no Hydra head input check).
   * For initial commits, uses Commit + CombinedCommit redeemers which check Hydra head input.
   * Defaults to true for incremental commits.
   */
  isIncrementalCommit?: boolean;
};

/**
 * Builds a blueprint transaction for incremental commit to an OPEN Hydra head.
 * This blueprint is required when committing script-locked UTxOs because Hydra needs
 * to know how to spend them (with proper redeemers and script references).
 * 
 * For incremental commits (deposits to OPEN head):
 * - Uses PartialCommit spend redeemer + CombinedPartialCommit withdrawal redeemer
 * - CombinedPartialCommit only requires admin signature (no Hydra head input check)
 * 
 * For initial commits (during head opening):
 * - Uses Commit spend redeemer + CombinedCommit withdrawal redeemer
 * - CombinedCommit requires Hydra head input in the transaction
 * 
 * For incremental commits, the reference script UTXO may have been committed to the head
 * during initialization. In this case, we include the script inline in the witness set
 * instead of as a reference input.
 * 
 * @param lucid - The LucidEvolution instance to use for building the transaction.
 * @param params - The parameters including deposited UTXO and validator reference.
 * @returns The blueprint transaction in CBORHex format.
 */
async function buildIncrementalCommitBlueprint(
  lucid: LucidEvolution,
  params: IncrementalCommitBlueprintParams
): Promise<CBORHex> {
  const { 
    adminAddress, 
    depositedUtxo, 
    validatorRefUtxo, 
    useRefInput = false,
    isIncrementalCommit = true  // Default to true for incremental commits
  } = params;
  
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
  
  // Add spend redeemers for script UTxOs
  // For incremental commits, use PartialCommit (requires CombinedPartialCommit withdrawal)
  // For initial commits, use Commit (requires CombinedCommit withdrawal with Hydra head input)
  const spendRedeemer = isIncrementalCommit ? Spend.PartialCommit : Spend.Commit;
  
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
  
  // Add withdrawal - ALWAYS required by the on-chain script for both Commit and PartialCommit
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
  
  // Add withdraw redeemer - use CombinedPartialCommit for incremental commits (only checks admin sig)
  // or CombinedCommit for initial commits (checks Hydra head input)
  const withdrawRedeemer = isIncrementalCommit 
    ? Combined.CombinedPartialCommit 
    : Combined.CombinedCommit;
  
  conwayRedeemers.insert(
    CML.RedeemerKey.new(CML.RedeemerTag.Reward, 0n),
    CML.RedeemerVal.new(
      CML.PlutusData.from_cbor_hex(withdrawRedeemer),
      CML.ExUnits.new(0n, 0n)
    )
  );
  
  // Add the validator script - either as reference input or inline
  if (useRefInput) {
    // Use reference input (only if the ref script UTXO is still on L1)
    const referenceInputs = CML.TransactionInputList.new();
    const validatorInput = utxoToCore(validatorRefUtxo).input();
    referenceInputs.add(validatorInput);
    txBody.set_reference_inputs(referenceInputs);
  } else {
    // Include the script inline in the witness set
    // This is necessary when the ref script UTXO was committed to the head
    const plutusScripts = CML.PlutusV3ScriptList.new();
    const scriptCbor = validator.script;
    const plutusScript = CML.PlutusV3Script.from_cbor_hex(scriptCbor);
    plutusScripts.add(plutusScript);
    txWitnessSet.set_plutus_v3_scripts(plutusScripts);
  }
  
  // Add redeemers to witness set
  const redeemers = CML.Redeemers.new_map_redeemer_key_to_redeemer_val(conwayRedeemers);
  txWitnessSet.set_redeemers(redeemers);
  
  const cbor = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();
  
  return cbor;
}

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
  const { scriptAddress, rewardAddress } = getValidatorDetails(
    validator,
    network
  );
  const adminKey = getAddressDetails(adminAddress).paymentCredential
    ?.hash as string;

  if (userFundUtxos.length === 0) {
    // Commit with an empty blueprint tx
    return { tx: undefined };
  }

  const allInputs = userFundUtxos;
  if (adminCollateral) {
    allInputs.push(adminCollateral);
  }
  const sortedInputs = sortUTxOs(allInputs, 'Canonical');

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

  // Add redeemers and validator only if there were script utxos being committed
  if (userFundUtxos.length > 0) {
    const conwayRedeemers = CML.MapRedeemerKeyToRedeemerVal.new();

    // Add spend redeemers
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

    // Add withdraw redeemer
    conwayRedeemers.insert(
      CML.RedeemerKey.new(CML.RedeemerTag.Reward, 0n),
      CML.RedeemerVal.new(
        CML.PlutusData.from_cbor_hex(Combined.CombinedCommit),
        CML.ExUnits.new(0n, 0n)
      )
    );

    // Add the validator as reference script
    const referenceInputs = CML.TransactionInputList.new();
    const validatorInput = utxoToCore(validatorRefUtxo).input();
    referenceInputs.add(validatorInput);
    txBody.set_reference_inputs(referenceInputs);

    // Add the redeemers to the witness set
    const redeemers =
      CML.Redeemers.new_map_redeemer_key_to_redeemer_val(conwayRedeemers);
    txWitnessSet.set_redeemers(redeemers);
  }

  const cbor = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();

  return { tx: cbor };
}

export { commitFunds, buildIncrementalCommitBlueprint, IncrementalCommitBlueprintParams };
