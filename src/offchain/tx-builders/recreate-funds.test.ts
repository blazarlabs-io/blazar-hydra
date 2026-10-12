import { describe, expect, it } from 'vitest';
import {
  CML,
  credentialToAddress,
  Data,
  Emulator,
  generateEmulatorAccount,
  getAddressDetails,
  Lucid,
  scriptFromNative,
  SLOT_CONFIG_NETWORK,
  utxoToTransactionInput,
  utxoToTransactionOutput,
  UTxO,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import * as UPLC from '@lucid-evolution/uplc';
import { buildValidator } from '../validator/handle';
import { bech32ToAddressType, getValidatorDetails } from '../lib/utils';
import { FundsDatum, FundsDatumT, Spend } from '../lib/types';
import { deposit } from './deposit';
import { recreateFunds } from './recreate-funds';

const ADMIN_KEY = 'ad'.repeat(28);
const HYDRA_KEY = 'aa'.repeat(28);

describe('recreateFunds (L2: a user funds UTxO leaves the head unchanged)', () => {
  it('spends the funds UTxO with AddFunds and recreates it as the only output, same address, value and datum', async () => {
    const lucid = await Lucid(new Emulator([generateEmulatorAccount({ lovelace: 10_000_000n })]), 'Custom');
    const validator = buildValidator(ADMIN_KEY, { Script_cred: { Key: HYDRA_KEY } });
    const { scriptAddress, scriptHash } = getValidatorDetails(validator, 'Custom');
    const owner = credentialToAddress('Custom', { type: 'Key', hash: 'e2'.repeat(28) }, { type: 'Key', hash: '0f'.repeat(28) });
    const token = `${scriptHash}${'01'.repeat(32)}`;
    const fund: UTxO = {
      txHash: '33'.repeat(32),
      outputIndex: 1,
      address: scriptAddress,
      assets: { lovelace: 30_000_000n, [token]: 1n },
      datum: Data.to<FundsDatumT>(
        {
          addr: bech32ToAddressType(lucid, owner),
          locked_deposit: 2_000_000n,
          funds_type: { User: { public_key: '8a'.repeat(32) } },
        },
        FundsDatum
      ),
    };
    const collateral: UTxO = {
      txHash: '44'.repeat(32),
      outputIndex: 0,
      address: credentialToAddress('Custom', { type: 'Key', hash: ADMIN_KEY }),
      assets: { lovelace: 50_000_000n },
    };

    const { tx } = await recreateFunds(lucid, {
      fundUtxo: fund,
      adminCollateral: collateral,
      adminKey: ADMIN_KEY,
      hydraKey: HYDRA_KEY,
    });

    const cml = CML.Transaction.from_cbor_hex(tx.toCBOR());
    const body = cml.body();
    expect(body.inputs().len()).toBe(1);
    expect(body.inputs().get(0).transaction_id().to_hex()).toBe(fund.txHash);
    expect(body.inputs().get(0).index()).toBe(1n);
    expect(body.outputs().len()).toBe(1);
    const out = body.outputs().get(0);
    expect(out.address().to_bech32()).toBe(scriptAddress);
    expect(out.amount().coin()).toBe(30_000_000n);
    expect(
      out.amount().multi_asset().get(CML.ScriptHash.from_hex(scriptHash), CML.AssetName.from_hex('01'.repeat(32)))
    ).toBe(1n);
    expect(out.datum()?.as_datum()?.to_cbor_hex()).toBe(fund.datum);
    expect(body.mint()).toBeUndefined();
    expect(body.collateral_inputs()?.get(0).transaction_id().to_hex()).toBe(collateral.txHash);
    const redeemers = cml.witness_set().redeemers()!.as_arr_legacy_redeemer()!;
    expect(redeemers.len()).toBe(1);
    expect(redeemers.get(0).tag()).toBe(CML.RedeemerTag.Spend);
    expect(redeemers.get(0).data().to_cbor_hex()).toBe(Spend.AddFunds);
    expect(cml.witness_set().plutus_v3_scripts()?.get(0).hash().to_hex()).toBe(scriptHash);
  });

  it('passes the real validator: AddFunds with nothing added (add_funds_min_lovelace = 0)', async () => {
    const admin = generateEmulatorAccount({ lovelace: 1_000_000_000n });
    const owner = generateEmulatorAccount({ lovelace: 5_000_000n });
    const emulator = new Emulator([admin, owner]);
    const lucid = await Lucid(emulator, 'Custom');
    const adminKey = getAddressDetails(admin.address).paymentCredential!.hash;
    const validator = buildValidator(adminKey, { Script_cred: { Key: HYDRA_KEY } });
    const { scriptAddress, rewardAddress } = getValidatorDetails(validator, 'Custom');
    const submit = async (cbor: string) => {
      lucid.selectWallet.fromSeed(admin.seedPhrase);
      const hash = await (await lucid.fromTx(cbor).sign.withWallet().complete()).submit();
      emulator.awaitBlock(1);
      return hash;
    };
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    const refHolder = validatorToAddress('Custom', scriptFromNative({ type: 'sig', keyHash: adminKey }));
    const deployTx = await lucid
      .newTx()
      .pay.ToAddressWithData(refHolder, { kind: 'inline', value: Data.void() }, { lovelace: 30_000_000n }, validator)
      .register.Stake(rewardAddress)
      .complete();
    const [validatorRef] = await lucid.utxosByOutRef([{ txHash: await submit(deployTx.toCBOR()), outputIndex: 0 }]);
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    const { tx: depositTx } = await deposit(
      lucid,
      {
        userAddress: owner.address,
        publicKey: '8a'.repeat(32),
        amountsToDeposit: { lovelace: 30_000_000n },
        walletUtxos: await lucid.wallet().getUtxos(),
        validatorRef,
      },
      admin.address
    );
    await submit(depositTx.toCBOR());
    const [fund] = await lucid.utxosAt(scriptAddress);
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    const [collateral] = await lucid.wallet().getUtxos();

    const { tx } = await recreateFunds(lucid, { fundUtxo: fund, adminCollateral: collateral, adminKey, hydraKey: HYDRA_KEY });

    // L2 fees are zero, so the emulator cannot accept the tx itself. Run the validator directly,
    // the way Lucid evaluates scripts in complete(); a failing script throws.
    const params = lucid.config().protocolParameters!;
    const slot = SLOT_CONFIG_NETWORK['Custom'];
    const spent = [fund, collateral];
    const evaluated = UPLC.eval_phase_two_raw(
      CML.Transaction.from_cbor_hex(tx.toCBOR()).to_cbor_bytes(),
      spent.map((u) => utxoToTransactionInput(u).to_cbor_bytes()),
      spent.map((u) => utxoToTransactionOutput(u).to_cbor_bytes()),
      lucid.config().costModels!.to_cbor_bytes(),
      params.maxTxExSteps,
      params.maxTxExMem,
      BigInt(slot.zeroTime),
      BigInt(slot.zeroSlot),
      slot.slotLength
    );
    expect(evaluated).toHaveLength(1);
  });
});
