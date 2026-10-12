import { describe, expect, it } from 'vitest';
import { CML, credentialToAddress, Data, LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { buildValidator } from '../validator/handle';
import { bech32ToAddressType, getValidatorDetails } from '../lib/utils';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { buildIncrementalCommitBlueprint } from './commit-funds';

const lucid = { config: () => ({ network: 'Preprod' }) } as unknown as LucidEvolution;
const ADMIN_KEY = 'ad'.repeat(28);
const admin = credentialToAddress('Preprod', { type: 'Key', hash: ADMIN_KEY });
const validator = buildValidator(ADMIN_KEY, { Script_cred: { Key: 'aa'.repeat(28) } });
const { scriptAddress } = getValidatorDetails(validator, 'Preprod');
const owner = credentialToAddress(
  'Preprod',
  { type: 'Key', hash: 'e2'.repeat(28) },
  { type: 'Key', hash: '0f'.repeat(28) }
);

describe('incremental commit blueprint', () => {
  it('deposits exactly the funds UTxO; the validator ref UTxO is only a reference input', async () => {
    const funds: UTxO = {
      txHash: '33'.repeat(32),
      outputIndex: 1,
      address: scriptAddress,
      assets: { lovelace: 20_000_000n, [`${'cc'.repeat(28)}${'01'.repeat(32)}`]: 1n },
      datum: Data.to<FundsDatumT>(
        {
          addr: bech32ToAddressType(lucid, owner),
          locked_deposit: 2_000_000n,
          funds_type: { User: { public_key: '8a'.repeat(32) } },
        },
        FundsDatum
      ),
    };
    const validatorRef: UTxO = {
      txHash: '44'.repeat(32),
      outputIndex: 0,
      address: admin,
      assets: { lovelace: 68_270_400n },
      scriptRef: validator,
    };
    const cbor = await buildIncrementalCommitBlueprint(lucid, {
      adminAddress: admin,
      depositedUtxo: funds,
      validatorRefUtxo: validatorRef,
    });
    const body = CML.Transaction.from_cbor_hex(cbor).body();
    expect(body.inputs().len()).toBe(1);
    expect(body.inputs().get(0).transaction_id().to_hex()).toBe(funds.txHash);
    expect(body.outputs().len()).toBe(1);
    const out = body.outputs().get(0);
    expect(out.address().to_bech32()).toBe(scriptAddress);
    expect(out.amount().coin()).toBe(20_000_000n);
    expect(out.datum()?.as_datum()?.to_cbor_hex()).toBe(funds.datum);
    expect(body.reference_inputs()?.get(0).transaction_id().to_hex()).toBe(validatorRef.txHash);
  });
});
