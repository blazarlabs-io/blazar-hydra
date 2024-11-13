import {
  addAssets,
  Data,
  CML,
  getAddressDetails,
  LucidEvolution,
  OutRef,
  toUnit,
  TxSignBuilder,
  utxoToCore,
  validatorToAddress,
  assetsToValue,
} from "@lucid-evolution/lucid";
import { PayMerchantParams } from "../lib/params";
import { buildValidator } from "../validator/handle";
import { FundsDatum, FundsDatumT, Mint, PayInfoT, Spend } from "../lib/types";
import { bech32ToAddressType, dataAddressToBech32 } from "../lib/utils";
import blake2b from "blake2b";

async function payMerchant(
  lucid: LucidEvolution,
  params: PayMerchantParams
): Promise<{ tx: TxSignBuilder; userUtxo: OutRef; merchantUtxo: OutRef }> {
  const {
    adminCollateral,
    userFundsUtxo,
    merchantAddress,
    amountToPay,
    signature,
    adminKey,
    hydraKey,
    merchantFundsUtxo,
  } = params;
  const validator = buildValidator(adminKey, {
    Script_cred: { Key: hydraKey },
  });
  if (!validator) {
    throw new Error("Invalid validator");
  }
  const scriptAddress = validatorToAddress(lucid.config().network, validator);
  const policyId = getAddressDetails(scriptAddress).paymentCredential?.hash;
  if (!policyId) {
    throw new Error("Invalid script address");
  }

  // Build inputs
  const allInputs = [userFundsUtxo].concat(
    merchantFundsUtxo ? [merchantFundsUtxo] : []
  );
  const sortedInputs = allInputs.sort((a, b) => {
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
  // User
  const newUserValue = assetsToValue(
    addAssets(userFundsUtxo.assets, { lovelace: -amountToPay })
  );
  if (!userFundsUtxo.datum) {
    throw new Error("User UTxO datum not found");
  }
  const userOutput = CML.TransactionOutput.new(
    CML.Address.from_bech32(userFundsUtxo.address),
    newUserValue,
    CML.DatumOption.new_datum(
      CML.PlutusData.from_cbor_hex(userFundsUtxo.datum!)
    )
  );
  // Merchant
  const serializedIndex = Data.to<bigint>(BigInt(userFundsUtxo.outputIndex));
  const newTokenName = Buffer.from(
    userFundsUtxo.txHash + serializedIndex,
    "hex"
  );
  const tokenNameHash = blake2b(32).update(newTokenName).digest("hex");
  const validationToken = toUnit(policyId, tokenNameHash);
  const newMerchValue = {
    [validationToken]: 1n,
    ["lovelace"]:
      amountToPay +
      (merchantFundsUtxo ? merchantFundsUtxo.assets["lovelace"] : 0n),
  };
  const merchDatum = Data.to<FundsDatumT>(
    {
      addr: bech32ToAddressType(lucid, merchantAddress),
      locked_deposit: 0n,
      funds_type: "Merchant",
    },
    FundsDatum
  );
  const merchantOutput = CML.TransactionOutput.new(
    CML.Address.from_bech32(scriptAddress),
    assetsToValue(newMerchValue),
    CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(merchDatum))
  );
  // Merchant output first
  outputs.add(merchantOutput);
  outputs.add(userOutput);

  // Build txBody
  const fee = 0n;
  const txBody = CML.TransactionBody.new(inputs, outputs, fee);

  // Set mint
  const mint = CML.Mint.new();
  const policy = CML.ScriptHash.from_hex(policyId);
  const name = CML.AssetName.from_hex(tokenNameHash);
  mint.set(policy, name, 1n);
  txBody.set_mint(mint);

  // Add collateral
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
  sortedInputs.map((inp, idx) => {
    const tag = CML.RedeemerTag.Spend;
    const index = BigInt(idx);
    const inpDatum = Data.from<FundsDatumT>(inp.datum!, FundsDatum);
    let data, units;
    if (inpDatum.funds_type === "Merchant") {
      data = CML.PlutusData.from_cbor_hex(Spend.AddFunds);
      units = CML.ExUnits.new(0n, 0n);
    } else {
      const payInfo: PayInfoT = {
        amount: amountToPay,
        merchant_addr: bech32ToAddressType(lucid, merchantAddress),
        ref: {
          transaction_id: userFundsUtxo.txHash,
          output_index: BigInt(userFundsUtxo.outputIndex),
        },
      };
      data = CML.PlutusData.from_cbor_hex(Spend.Pay(payInfo, signature));
      units = CML.ExUnits.new(3_000_000n, 3_000_000_000n);
    }
    legacyRedeemers.add(CML.LegacyRedeemer.new(tag, index, data, units));
  });

  // Add mint redeemer
  legacyRedeemers.add(
    CML.LegacyRedeemer.new(
      CML.RedeemerTag.Mint,
      0n,
      CML.PlutusData.from_cbor_hex(
        Mint.Mint({
          transaction_id: userFundsUtxo.txHash,
          output_index: BigInt(userFundsUtxo.outputIndex),
        })
      ),
      CML.ExUnits.new(3_000_000n, 3_000_000_000n)
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
  return {
    tx,
    merchantUtxo: { txHash: tx.toCBOR(), outputIndex: 0 },
    userUtxo: { txHash: tx.toCBOR(), outputIndex: 1 },
  };
}

export { payMerchant };
