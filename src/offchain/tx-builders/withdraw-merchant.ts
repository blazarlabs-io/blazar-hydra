import {
  addAssets,
  assetsToValue,
  CML,
  Data,
  fromUnit,
  LucidEvolution,
  sortUTxOs,
  TxSignBuilder,
} from '@lucid-evolution/lucid';
import { WithdrawParams } from '../lib/params';
import { buildValidator } from '../validator/handle';
import {
  Combined,
  FundsDatum,
  FundsDatumT,
  Mint,
  OutputRefSchema,
  OutputRefT,
  Spend,
  WithdrawInfoT,
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

const WITHDRAW_EXUNITS = () => CML.ExUnits.new(20_000_000n, 1000_000_000_000n);

/**
 * Builds an L2 withdraw (decommit) transaction for merchant OR user funds.
 *
 * Merchant and user funds validate differently on-chain:
 * - Merchant (`MerchantWithdraw`): self-contained spend validation; the payout output
 *   carries the input's OutRef as its inline datum.
 * - User (`UserWithdraw`): withdraw-zero pattern — the real checks run in the
 *   `CombinedWithdraw` reward redeemer (`validate_combined_withdraw`), which requires the
 *   payout output to have NO datum. The spend redeemer carries a `WithdrawInfo { ref }`.
 *
 * The validator script is attached inline (so this works inside the head, where the L1
 * reference-script UTxO is not present) and admin collateral is set explicitly from L2.
 */
async function withdrawMerchant(
  lucid: LucidEvolution,
  params: WithdrawParams
): Promise<{ tx: TxSignBuilder }> {
  const { kind, adminKey, hydraKey, withdraws, walletUtxos } = params;
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
  const { scriptHash: policyId, rewardAddress } = getValidatorDetails(
    validator,
    network
  );

  // Build inputs (keep each fund UTxO's signature reachable for the user redeemer).
  const sigByRef = new Map(
    withdraws.map((w) => [
      `${w.fundUtxo.txHash}#${w.fundUtxo.outputIndex}`,
      w.signature,
    ])
  );
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

    // Build the payout output (to the address stored in the datum)
    const payoutValue = addAssets(utxo.assets, { [validationToken[0]]: -1n });
    const datum = Data.from<FundsDatumT>(utxo.datum!, FundsDatum);
    const payoutAddress = CML.Address.from_bech32(
      dataAddressToBech32(lucid, datum.addr)
    );
    let cmlOutput: CML.TransactionOutput;
    if (kind === 'merchant') {
      // Merchant payout carries the input OutRef as inline datum.
      const inpRef = Data.to<OutputRefT>(
        {
          transaction_id: utxo.txHash,
          output_index: BigInt(utxo.outputIndex),
        },
        OutputRefSchema as unknown as OutputRefT
      );
      cmlOutput = CML.TransactionOutput.new(
        payoutAddress,
        assetsToValue(payoutValue),
        CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(inpRef))
      );
    } else {
      // User payout must have NO datum (validate_combined_withdraw requirement).
      cmlOutput = CML.TransactionOutput.new(
        payoutAddress,
        assetsToValue(payoutValue)
      );
    }
    outputs.add(cmlOutput);
  });

  // Build txBody
  const txBody = buildTxBody(inputs, outputs, burn);

  // User funds use the withdraw-zero pattern: a 0 withdrawal from the validator's reward
  // address carries the CombinedWithdraw redeemer that runs the real validation.
  if (kind === 'user') {
    const rewAddr = CML.RewardAddress.from_address(
      CML.Address.from_bech32(rewardAddress)
    );
    if (!rewAddr) {
      throw new Error('Could not build reward address from validator');
    }
    const withdrawals = CML.MapRewardAccountToCoin.new();
    withdrawals.insert(rewAddr, 0n);
    txBody.set_withdrawals(withdrawals);
  }

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

  // Add spend redeemers (per-input; user carries WithdrawInfo + signature)
  sortedInputs.map((utxo, idx) => {
    const tag = CML.RedeemerTag.Spend;
    const index = BigInt(idx);
    let redeemer: string;
    if (kind === 'merchant') {
      redeemer = Spend.MerchantWithdraw;
    } else {
      const info: WithdrawInfoT = {
        ref: {
          transaction_id: utxo.txHash,
          output_index: BigInt(utxo.outputIndex),
        },
      };
      const sig = sigByRef.get(`${utxo.txHash}#${utxo.outputIndex}`) ?? '';
      redeemer = Spend.UserWithdraw(info, sig);
    }
    const data = CML.PlutusData.from_cbor_hex(redeemer);
    redeemers.add(CML.LegacyRedeemer.new(tag, index, data, WITHDRAW_EXUNITS()));
  });

  // Add mint redeemer (burn the validation tokens)
  addMintRedeemer(redeemers, Mint.Burn);

  // Add the reward (withdrawal) redeemer for the user withdraw-zero path
  if (kind === 'user') {
    redeemers.add(
      CML.LegacyRedeemer.new(
        CML.RedeemerTag.Reward,
        0n,
        CML.PlutusData.from_cbor_hex(Combined.CombinedWithdraw),
        WITHDRAW_EXUNITS()
      )
    );
  }

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
