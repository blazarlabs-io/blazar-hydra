import { assetsToValue, CML, LucidEvolution, TxSignBuilder, UTxO } from '@lucid-evolution/lucid';
import { buildValidator } from '../validator/handle';
import { Spend } from '../lib/types';
import {
  buildInputs,
  buildTxBody,
  setCollateralInputs,
  setPlutusScripts,
  setRedeemers,
  setRequiredSigners,
  setScriptDataHash,
} from '../lib/transaction';

/**
 * L2 tx that spends a user funds UTxO with `AddFunds` and recreates it unchanged (same address,
 * value and datum; `add_funds_min_lovelace` is 0). Sent as a decommit, it moves the UTxO to L1
 * with its validation token, so the token is burned on L1 by `UserWithdraw`. Burning it inside L2
 * instead would leave the token in the L1 head output and block the fanout (H4).
 * The validator is attached inline: the reference-script UTxO is not in the head.
 */
async function recreateFunds(
  lucid: LucidEvolution,
  params: { fundUtxo: UTxO; adminCollateral: UTxO; adminKey: string; hydraKey: string }
): Promise<{ tx: TxSignBuilder }> {
  const { fundUtxo, adminCollateral, adminKey, hydraKey } = params;
  if (!fundUtxo.datum) {
    throw new Error(`Funds UTxO ${fundUtxo.txHash}#${fundUtxo.outputIndex} has no inline datum`);
  }
  const validator = buildValidator(adminKey, { Script_cred: { Key: hydraKey } });

  const outputs = CML.TransactionOutputList.new();
  outputs.add(
    CML.TransactionOutput.new(
      CML.Address.from_bech32(fundUtxo.address),
      assetsToValue(fundUtxo.assets),
      CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(fundUtxo.datum))
    )
  );
  const txBody = buildTxBody(buildInputs([fundUtxo]), outputs, undefined);
  setCollateralInputs(txBody, adminCollateral);
  setRequiredSigners(txBody, adminKey);

  const witnesses = CML.TransactionWitnessSet.new();
  const redeemers = CML.LegacyRedeemerList.new();
  redeemers.add(
    CML.LegacyRedeemer.new(
      CML.RedeemerTag.Spend,
      0n,
      CML.PlutusData.from_cbor_hex(Spend.AddFunds),
      CML.ExUnits.new(3_000_000n, 3_000_000_000n)
    )
  );
  setRedeemers(witnesses, redeemers);
  setPlutusScripts(witnesses, validator.script);
  setScriptDataHash(lucid, txBody, witnesses);

  return { tx: lucid.fromTx(CML.Transaction.new(txBody, witnesses, true).to_cbor_hex()) };
}

export { recreateFunds };
