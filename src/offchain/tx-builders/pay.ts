import {
  addAssets,
  Data,
  CML,
  LucidEvolution,
  OutRef,
  toUnit,
  TxSignBuilder,
  utxoToCore,
  assetsToValue,
  sortUTxOs,
  Assets,
  UTxO,
  Script,
} from '@lucid-evolution/lucid';
import { PayMerchantParams } from '../lib/params';
import { buildValidator } from '../validator/handle';
import { FundsDatum, FundsDatumT, Mint, PayInfoT, Spend } from '../lib/types';
import {
  assetsToDataPairs,
  bech32ToAddressType,
  getNetworkFromLucid,
  getValidatorDetails,
} from '../lib/utils';
import blake2b from 'blake2b';

async function payMerchant(
  lucid: LucidEvolution,
  params: PayMerchantParams
): Promise<{ tx: TxSignBuilder; userUtxo: OutRef; merchantUtxo: OutRef }> {
  const {
    adminCollateral,
    userFundsUtxo,
    merchantAddress,
    assets: amountToPay,
    signature,
    adminKey,
    hydraKey,
    merchantFundsUtxo,
  } = params;
  const validator = buildValidator(adminKey, {
    Script_cred: { Key: hydraKey },
  });
  if (!validator) {
    throw new Error('Invalid validator');
  }

  const allInputs = [userFundsUtxo];
  if (merchantFundsUtxo) {
    allInputs.push(merchantFundsUtxo);
  }
  const sortedInputs = sortUTxOs(allInputs, 'Canonical');

  // Build inputs
  const inputs = buildInputs(sortedInputs);

  // Build outputs
  const { outputs, minting } = buildOutputs(
    lucid,
    amountToPay,
    merchantAddress,
    userFundsUtxo,
    validator,
    merchantFundsUtxo
  );

  // Build txBody
  const txBody = buildTxBody(inputs, outputs, minting);

  // Add collateral
  setCollateralInputs(txBody, adminCollateral);

  // Add required signers
  setRequiredSigners(txBody, adminKey);

  // Build redeemers
  const redeemers = buildRedeemers(
    lucid,
    sortedInputs,
    amountToPay,
    signature,
    !!minting,
    userFundsUtxo,
    merchantAddress
  );

  // Create transaction witness set
  const txWitnessSet = CML.TransactionWitnessSet.new();

  // Set redeeemers
  setRedeemers(txWitnessSet, redeemers);

  // Add plutus script
  setPlutusScripts(txWitnessSet, validator.script);

  // Calculate script data hash
  setScriptDataHash(lucid, txBody, txWitnessSet);

  // Complete transaction
  const cmlTx = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();
  const tx = lucid.fromTx(cmlTx);
  return {
    tx,
    merchantUtxo: { txHash: tx.toHash(), outputIndex: 0 },
    userUtxo: { txHash: tx.toHash(), outputIndex: 1 },
  };
}

export { payMerchant };

// Negate all values in an assets object
function negate(assets: Assets): Assets {
  return Object.fromEntries(
    Object.entries(assets).map(([asset, value]) => {
      return [asset, -value];
    })
  );
}

//////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////
//////////////// Transaction modifiers and builders //////////////////
//////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////

function buildInputs(sortedInputs: UTxO[]): CML.TransactionInputList {
  const inputs = CML.TransactionInputList.new();
  sortedInputs.map((utxo) => {
    const cmlInput = utxoToCore(utxo).input();
    inputs.add(cmlInput);
  });
  return inputs;
}

function buildOutputs(
  lucid: LucidEvolution,
  amountToPay: Assets,
  merchantAddress: string,
  userFundsUtxo: UTxO,
  validator: Script,
  merchantFundsUtxo?: UTxO
): { outputs: CML.TransactionOutputList; minting?: CML.Mint } {
  const network = getNetworkFromLucid(lucid);
  const { scriptAddress, scriptHash: policyId } = getValidatorDetails(
    validator,
    network
  );
  const outputs = CML.TransactionOutputList.new();

  // User
  if (!userFundsUtxo.datum) {
    throw new Error('User UTxO datum not found');
  }
  const newUserValue = assetsToValue(
    addAssets(userFundsUtxo.assets, negate(amountToPay))
  );
  const userOutput = CML.TransactionOutput.new(
    CML.Address.from_bech32(userFundsUtxo.address),
    newUserValue,
    CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(userFundsUtxo.datum))
  );

  // Merchant
  let newMerchValue: Assets = {};
  const minting = CML.Mint.new();

  // If there is a merchant UTxO, keep the validation token. Else mint a new one.
  if (merchantFundsUtxo) {
    newMerchValue = addAssets(merchantFundsUtxo.assets, amountToPay);
  } else {
    if (!amountToPay.lovelace || amountToPay.lovelace < 2_000_000n) {
      throw new Error(
        'Must include at least 2 ADA in the payment amount when paying to a new merchant'
      );
    }
    const serializedIndex = Data.to<bigint>(BigInt(userFundsUtxo.outputIndex));
    const newTokenName = Buffer.from(
      userFundsUtxo.txHash + serializedIndex,
      'hex'
    );
    const tokenNameHash = blake2b(32).update(newTokenName).digest('hex');

    const validationToken = toUnit(policyId, tokenNameHash);
    newMerchValue = addAssets({ [validationToken]: 1n }, amountToPay);

    // Set mint
    const policy = CML.ScriptHash.from_hex(policyId);
    const name = CML.AssetName.from_hex(tokenNameHash);
    minting.set(policy, name, 1n);
  }

  const merchDatum = Data.to<FundsDatumT>(
    {
      addr: bech32ToAddressType(lucid, merchantAddress),
      locked_deposit: 0n,
      funds_type: 'Merchant',
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

  return { outputs, minting };
}

function buildTxBody(
  inputs: CML.TransactionInputList,
  outputs: CML.TransactionOutputList,
  minting: CML.Mint | undefined
): CML.TransactionBody {
  const fee = 0n;
  const txBody = CML.TransactionBody.new(inputs, outputs, fee);
  if (minting) {
    txBody.set_mint(minting);
  }
  return txBody;
}

function setCollateralInputs(
  txBody: CML.TransactionBody,
  adminCollateral: UTxO
) {
  const collateral = CML.TransactionInputList.new();
  const cmlInput = utxoToCore(adminCollateral).input();
  collateral.add(cmlInput);
  txBody.set_collateral_inputs(collateral);
}

function setRequiredSigners(txBody: CML.TransactionBody, adminKey: string) {
  const signer = CML.Ed25519KeyHash.from_hex(adminKey);
  const signers = CML.Ed25519KeyHashList.new();
  signers.add(signer);
  txBody.set_required_signers(signers);
}

function setPlutusScripts(
  txWitnessSet: CML.TransactionWitnessSet,
  validator: string
) {
  const scripts = CML.PlutusV3ScriptList.new();
  const script = CML.PlutusV3Script.from_cbor_hex(validator);
  scripts.add(script);
  txWitnessSet.set_plutus_v3_scripts(scripts);
}

function addSpendRedeemers(
  legacyRedeemers: CML.LegacyRedeemerList,
  sortedInputs: UTxO[],
  payInfo: PayInfoT,
  signature: string
) {
  sortedInputs.map((inp, idx) => {
    const tag = CML.RedeemerTag.Spend;
    const index = BigInt(idx);
    const inpDatum = Data.from<FundsDatumT>(inp.datum!, FundsDatum);
    let data, units;
    if (inpDatum.funds_type === 'Merchant') {
      data = CML.PlutusData.from_cbor_hex(Spend.AddFunds);
      units = CML.ExUnits.new(0n, 0n);
    } else {
      data = CML.PlutusData.from_cbor_hex(Spend.Pay(payInfo, signature));
      units = CML.ExUnits.new(3_000_000n, 3_000_000_000n);
    }
    legacyRedeemers.add(CML.LegacyRedeemer.new(tag, index, data, units));
  });
}

function addMintRedeemer(
  legacyRedeemers: CML.LegacyRedeemerList,
  mintRedeemer?: string
) {
  if (!mintRedeemer) return;
  legacyRedeemers.add(
    CML.LegacyRedeemer.new(
      CML.RedeemerTag.Mint,
      0n,
      CML.PlutusData.from_cbor_hex(mintRedeemer),
      CML.ExUnits.new(3_000_000n, 3_000_000_000n)
    )
  );
}

function buildRedeemers(
  lucid: LucidEvolution,
  sortedInputs: UTxO[],
  amountToPay: Assets,
  signature: string,
  minting: boolean,
  userFundsUtxo: UTxO,
  merchantAddress: string
) {
  const legacyRedeemers = CML.LegacyRedeemerList.new();
  const userFundsOutRef = {
    transaction_id: userFundsUtxo.txHash,
    output_index: BigInt(userFundsUtxo.outputIndex),
  };

  // Add spend redeemers
  const payInfo: PayInfoT = {
    amount: assetsToDataPairs(amountToPay),
    merchant_addr: bech32ToAddressType(lucid, merchantAddress),
    ref: userFundsOutRef,
  };
  addSpendRedeemers(legacyRedeemers, sortedInputs, payInfo, signature);

  // Add mint redeemer
  const mintRedeemer = minting ? Mint.Mint(userFundsOutRef) : undefined;
  addMintRedeemer(legacyRedeemers, mintRedeemer);

  return legacyRedeemers;
}

function setRedeemers(
  txWitnessSet: CML.TransactionWitnessSet,
  legacyRedeemers: CML.LegacyRedeemerList
) {
  const redeemers = CML.Redeemers.new_arr_legacy_redeemer(legacyRedeemers);
  txWitnessSet.set_redeemers(redeemers);
}

function setScriptDataHash(
  lucid: LucidEvolution,
  txBody: CML.TransactionBody,
  txWitnessSet: CML.TransactionWitnessSet
) {
  const costModels = lucid.config().costModels;
  if (!costModels) {
    throw new Error('Cost models not set in Lucid configuration');
  }
  const language = CML.LanguageList.new();
  language.add(CML.Language.PlutusV3);
  const scriptDataHash = CML.calc_script_data_hash(
    txWitnessSet.redeemers()!,
    CML.PlutusDataList.new(),
    costModels,
    language
  );
  if (!scriptDataHash) {
    throw new Error(`Could not calculate script data hash`);
  } else {
    txBody.set_script_data_hash(scriptDataHash);
  }
}
