import { describe, expect, it } from 'vitest';
import {
  Data,
  Emulator,
  generateEmulatorAccount,
  getAddressDetails,
  Lucid,
  LucidEvolution,
  scriptFromNative,
  sortUTxOs,
  UTxO,
  validatorToAddress,
} from '@lucid-evolution/lucid';
import { buildValidator } from '../validator/handle';
import { getValidatorDetails } from '../lib/utils';
import { deposit } from './deposit';
import { withdrawUsersOnL1 } from './withdraw-user-l1';

const HYDRA_KEY = 'aa'.repeat(28);

// Runs the real validator in the emulator: deposits mint validation tokens on L1, then one L1
// UserWithdraw pays both owners and burns both tokens.
describe('withdrawUsersOnL1 (UserWithdraw on L1, token burned on L1)', () => {
  it('pays every owner their whole funds UTxO and burns the validation tokens', async () => {
    const admin = generateEmulatorAccount({ lovelace: 1_000_000_000n });
    const ownerA = generateEmulatorAccount({ lovelace: 5_000_000n });
    const ownerB = generateEmulatorAccount({ lovelace: 5_000_000n });
    const emulator = new Emulator([admin, ownerA, ownerB]);
    const lucid = await Lucid(emulator, 'Custom');
    lucid.selectWallet.fromSeed(admin.seedPhrase);
    const adminKey = getAddressDetails(admin.address).paymentCredential!.hash;
    const validator = buildValidator(adminKey, { Script_cred: { Key: HYDRA_KEY } });
    const { scriptAddress, scriptHash, rewardAddress } = getValidatorDetails(validator, 'Custom');

    const submit = async (cbor: string) => {
      lucid.selectWallet.fromSeed(admin.seedPhrase);
      const signed = await lucid.fromTx(cbor).sign.withWallet().complete();
      const hash = await signed.submit();
      emulator.awaitBlock(1);
      return hash;
    };

    // Reference script UTxO and the stake registration the withdraw-zero needs, as deploy-validator
    // does: the script sits at the admin's native-script address, outside the admin wallet.
    const refHolder = validatorToAddress('Custom', scriptFromNative({ type: 'sig', keyHash: adminKey }));
    const deployTx = await lucid
      .newTx()
      .pay.ToAddressWithData(refHolder, { kind: 'inline', value: Data.void() }, { lovelace: 30_000_000n }, validator)
      .register.Stake(rewardAddress)
      .complete();
    const deployHash = await submit(deployTx.toCBOR());
    const [validatorRef] = await lucid.utxosByOutRef([{ txHash: deployHash, outputIndex: 0 }]);

    const depositFor = async (owner: string) => {
      lucid.selectWallet.fromSeed(admin.seedPhrase);
      const walletUtxos = await lucid.wallet().getUtxos();
      const { tx } = await deposit(
        lucid as LucidEvolution,
        { userAddress: owner, publicKey: '8a'.repeat(32), amountsToDeposit: { lovelace: 30_000_000n }, walletUtxos, validatorRef },
        admin.address
      );
      await submit(tx.toCBOR());
    };
    await depositFor(ownerA.address);
    await depositFor(ownerB.address);
    // Reverse canonical order, so the builder's own sort (inputs and payouts paired in ledger
    // order) is always exercised.
    const funds: UTxO[] = sortUTxOs(await lucid.utxosAt(scriptAddress), 'Canonical').reverse();
    expect(funds).toHaveLength(2);

    lucid.selectWallet.fromSeed(admin.seedPhrase);
    const tx = await withdrawUsersOnL1(lucid, { fundUtxos: funds, validatorRef, adminAddress: admin.address });
    await submit(tx.toCBOR());

    expect(await lucid.utxosAt(scriptAddress)).toHaveLength(0);
    for (const owner of [ownerA, ownerB]) {
      const got = (await lucid.utxosAt(owner.address)).map((u) => u.assets.lovelace);
      expect(got).toContain(32_000_000n); // 30 ADA deposited + the 2 ADA minimum the deposit locks
    }
    const tokensLeft = (await lucid.utxosAt(admin.address)).flatMap((u) =>
      Object.keys(u.assets).filter((unit) => unit.startsWith(scriptHash))
    );
    expect(tokensLeft).toEqual([]);
  });
});
