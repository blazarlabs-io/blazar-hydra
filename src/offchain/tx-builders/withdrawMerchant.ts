import {
  assetsToValue,
  CML,
  Data,
  fromUnit,
  getAddressDetails,
  LucidEvolution,
  TxSignBuilder,
  utxoToCore,
  validatorToAddress,
  validatorToRewardAddress,
} from "@lucid-evolution/lucid";
import { WithdrawParams } from "../lib/params";
import { buildValidator } from "../validator/handle";
import {
  Combined,
  FundsDatum,
  FundsDatumT,
  Mint,
  OutputRefSchema,
  OutputRefT,
  Spend,
} from "../lib/types";
import { bech32ToAddressType, dataAddressToBech32 } from "../lib/utils";

async function withdrawMerchant(
  lucid: LucidEvolution,
  params: WithdrawParams
): Promise<{ tx: TxSignBuilder }> {
  const { adminKey, hydraKey, fundsUtxos, walletUtxos } = params;
  if (!adminKey || !hydraKey) {
    throw new Error("Must provide validator keys to build withdraw tx on L2");
  }
  const validator = buildValidator(adminKey, {
    Script_cred: { Key: hydraKey },
  });
  if (!validator) {
    throw new Error("Invalid validator");
  }
  const rewardAddress = validatorToRewardAddress(
    lucid.config().network,
    validator
  );
  const scriptAddress = validatorToAddress(lucid.config().network, validator);
  const policyId = getAddressDetails(scriptAddress).paymentCredential?.hash;
  if (!policyId) {
    throw new Error("Invalid script address");
  }

  // Build inputs
  const sortedInputs = fundsUtxos.sort((a, b) => {
    const ref1 = { hash: a.txHash, index: a.outputIndex };
    const ref2 = { hash: b.txHash, index: b.outputIndex };
    const hashComparison = ref1.hash.localeCompare(ref2.hash);
    return hashComparison !== 0 ? hashComparison : ref1.index - ref2.index;
  });
  const inputs = CML.TransactionInputList.new();
  sortedInputs.map((utxo) => {
    const cmlInput = utxoToCore(utxo).input();
    inputs.add(cmlInput);
  });

  // Build outputs
  const outputs = CML.TransactionOutputList.new();
  sortedInputs.map((utxo) => {
    const outValue = utxo.assets["lovelace"];
    const datum = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
    const inpRef = Data.to<OutputRefT>(
      {
        transaction_id: utxo.txHash,
        output_index: BigInt(utxo.outputIndex),
      },
      OutputRefSchema as unknown as OutputRefT
    );
    const cmlOutput = CML.TransactionOutput.new(
      CML.Address.from_bech32(dataAddressToBech32(lucid, datum.addr)),
      CML.Value.new(outValue, CML.MultiAsset.new()),
      CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(inpRef))
    );
    outputs.add(cmlOutput);
  });

  // Build txBody
  const fee = 0n;
  const txBody = CML.TransactionBody.new(inputs, outputs, fee);

  // Set burn
  const burn = CML.Mint.new();
  const policy = CML.ScriptHash.from_hex(policyId);
  sortedInputs.map((utxo) => {
    const validationToken = Object.entries(utxo.assets).find(
      ([asset, _]) => fromUnit(asset).policyId === policyId
    );
    if (!validationToken) {
      throw new Error("Invalid validation token");
    }
    const assetName = fromUnit(validationToken[0]).assetName!;
    const name = CML.AssetName.from_hex(assetName);
    burn.set(policy, name, -1n);
  });
  txBody.set_mint(burn);

  // Add collateral
  if (!walletUtxos) {
    throw new Error("Must provide collateral utxo to build withdraw tx on L2");
  }
  const adminCollateral = walletUtxos[0];
  const collateral = CML.TransactionInputList.new();
  const cmlInput = utxoToCore(adminCollateral).input();
  collateral.add(cmlInput);
  txBody.set_collateral_inputs(collateral);

  // Add required signers
  const signer = CML.Ed25519KeyHash.from_hex(adminKey);
  const signers = CML.Ed25519KeyHashList.new();
  signers.add(signer);
  txBody.set_required_signers(signers);

  // Create witness set
  const txWitnessSet = CML.TransactionWitnessSet.new();

  // Add spend redeemers
  const legacyRedeemers = CML.LegacyRedeemerList.new();
  sortedInputs.map((_, idx) => {
    const tag = CML.RedeemerTag.Spend;
    const index = BigInt(idx);
    let data, units;
    data = CML.PlutusData.from_cbor_hex(Spend.MerchantWithdraw);
    units = CML.ExUnits.new(20_000_000n, 1000_000_000_000n);
    legacyRedeemers.add(CML.LegacyRedeemer.new(tag, index, data, units));
  });

  // Add mint redeemer
  legacyRedeemers.add(
    CML.LegacyRedeemer.new(
      CML.RedeemerTag.Mint,
      0n,
      CML.PlutusData.from_cbor_hex(Mint.Burn),
      CML.ExUnits.new(20_000_000n, 1000_000_000_000n)
    )
  );

  // Build redeemers
  const redeemers = CML.Redeemers.new_arr_legacy_redeemer(legacyRedeemers);
  txWitnessSet.set_redeemers(redeemers);

  // Add plutus script
  const scripts = CML.PlutusV3ScriptList.new();
  const script = CML.PlutusV3Script.from_cbor_hex(validator.script);
  scripts.add(script);
  txWitnessSet.set_plutus_v3_scripts(scripts);

  // Calculate script data hash
  const costModels = lucid.config().costModels;
  const language = CML.LanguageList.new();
  language.add(CML.Language.PlutusV3);
  const scriptDataHash = CML.calc_script_data_hash(
    redeemers,
    CML.PlutusDataList.new(),
    costModels,
    language
  );
  if (!scriptDataHash) {
    throw new Error(`Could not calculate script data hash`);
  } else {
    txBody.set_script_data_hash(scriptDataHash);
  }

  // Complete transaction
  const cmlTx = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();
  const tx = lucid.fromTx(cmlTx);
  return { tx };
}

export { withdrawMerchant };
