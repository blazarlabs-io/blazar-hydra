import {
  addAssets,
  assetsToValue,
  CML,
  Data,
  fromUnit,
  LucidEvolution,
  sortUTxOs,
  TxSignBuilder,
  utxoToCore,
} from '@lucid-evolution/lucid';
import { WithdrawParams } from '../lib/params';
import { buildValidator } from '../validator/handle';
import {
  FundsDatum,
  FundsDatumT,
  Mint,
  OutputRefSchema,
  OutputRefT,
  Spend,
} from '../lib/types';
import {
  dataAddressToBech32,
  getNetworkFromLucid,
  getValidatorDetails,
} from '../lib/utils';
import {
  addMintRedeemer,
  buildInputs,
  buildTxBody,
  setCollateralInputs,
  setPlutusScripts,
  setRedeemers,
  setRequiredSigners,
  setScriptDataHash,
} from '../lib/transaction';

async function withdrawMerchant(
  lucid: LucidEvolution,
  params: WithdrawParams
): Promise<{ tx: TxSignBuilder }> {
  const { adminKey, hydraKey, withdraws, walletUtxos } = params;
  if (!adminKey || !hydraKey) {
    throw new Error('Must provide validator keys to build withdraw tx on L2');
  }
  const validator = buildValidator(adminKey, {
    Script_cred: { Key: hydraKey },
  });
  if (!validator) {
    throw new Error('Invalid validator');
  }
  const network = getNetworkFromLucid(lucid);
  const { scriptHash: policyId } = getValidatorDetails(validator, network);

  // Build inputs
  const fundsUtxos = withdraws.map((w) => w.fundUtxo);
  const sortedInputs = sortUTxOs(fundsUtxos, 'Canonical');
  const inputs = buildInputs(sortedInputs);

  // Build outputs and burn validation tokens
  const policy = CML.ScriptHash.from_hex(policyId);
  const outputs = CML.TransactionOutputList.new();
  const burn = CML.Mint.new();
  sortedInputs.map((utxo) => {
    // First add the validation token to the burn list
    const validationToken = Object.entries(utxo.assets).find(
      ([asset]) => fromUnit(asset).policyId === policyId
    );
    if (!validationToken) {
      throw new Error('Invalid validation token');
    }
    const assetName = fromUnit(validationToken[0]).assetName!;
    const name = CML.AssetName.from_hex(assetName);
    burn.set(policy, name, -1n);

    // Now build the output for the merchant
    const payoutValue = addAssets(utxo.assets, { [validationToken[0]]: -1n });
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
      assetsToValue(payoutValue),
      CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(inpRef))
    );
    outputs.add(cmlOutput);
  });

  // Build txBody
  const txBody = buildTxBody(inputs, outputs, burn);

  // Add collateral
  if (!walletUtxos) {
    throw new Error('Must provide collateral utxo to build withdraw tx on L2');
  }
  const adminCollateral = walletUtxos[0];
  setCollateralInputs(txBody, adminCollateral);

  // Add required signers
  setRequiredSigners(txBody, adminKey);

  // Create witness set
  const txWitnessSet = CML.TransactionWitnessSet.new();

  // Build and set redeemers
  const redeemers = CML.LegacyRedeemerList.new();

  // Add spend redeemers
  sortedInputs.map((_, idx) => {
    const tag = CML.RedeemerTag.Spend;
    const index = BigInt(idx);
    const data = CML.PlutusData.from_cbor_hex(Spend.MerchantWithdraw);
    const units = CML.ExUnits.new(20_000_000n, 1000_000_000_000n);
    redeemers.add(CML.LegacyRedeemer.new(tag, index, data, units));
  });

  // Add mint redeemer
  addMintRedeemer(redeemers, Mint.Burn);

  // Build redeemers
  setRedeemers(txWitnessSet, redeemers);

  // Add plutus script
  setPlutusScripts(txWitnessSet, validator.script);

  // Calculate script data hash
  setScriptDataHash(lucid, txBody, txWitnessSet);

  // Complete transaction
  const cmlTx = CML.Transaction.new(txBody, txWitnessSet, true).to_cbor_hex();
  const tx = lucid.fromTx(cmlTx);
  return { tx };
}

export { withdrawMerchant };
