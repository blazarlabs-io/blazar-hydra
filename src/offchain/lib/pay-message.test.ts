import { describe, expect, it } from 'vitest';
import {
  CML,
  credentialToRewardAddress,
  Data,
  LucidEvolution,
} from '@lucid-evolution/lucid';
import { PayInfo, PayInfoT } from './types';
import { assetsToDataPairs, bech32ToAddressType } from './utils';
import {
  payInfoCbor,
  PlutusData,
  plutusCbor,
  verifyPaySignature,
} from './pay-message';

// Golden vectors, checked against Aiken v1.1.17 (onchain/hydra-pay/lib/consent.ak) and the mobile app.
const MERCHANT =
  'addr_test1qrs7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rcg0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8sxahxqw';
const ENTERPRISE = 'addr_test1vrs7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rc0pu8s7rcgurlewq';
const USDM = 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d';
const PAYER_PK = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c'; // seed 01×32
const OTHER_PK = '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394'; // seed 02×32
const ADA_MSG =
  'd8799fa140a1401a004c4b40d8799fd8799f581ce1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1ffd8799fd8799fd8799f581c0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0fffffffffd8799f5820111111111111111111111111111111111111111111111111111111111111111100ffff';
const ADA_SIG =
  '722aea99e109cc990a416a8b84a6ead4a1568c5dbebb4755b52c56382056aa7d1f8b6ba42e42526ea97e0281145102b813229077bfa376888f967e477f688a04';
const USDM_MSG =
  'd8799fa1581ce675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9a1490014df10745553444d1a0016e360d8799fd8799f581ce1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1ffd87a80ffd8799f5820222222222222222222222222222222222222222222222222222222222222222203ffff';
const USDM_SIG =
  '7368184e25aa0cc89aec962c13b01b9827703b06f2a36f4d31644e84092e17fa258b5b2d58089ded6f251764b84cdf5686bac9e6c949efddf2baaa58b0876409';

// test-only: CML's detailed JSON of a datum -> PlutusData (amounts here stay below 2^53)
type DetailedJson = {
  constructor?: number;
  fields?: DetailedJson[];
  map?: { k: DetailedJson; v: DetailedJson }[];
  bytes?: string;
  int?: number;
};
const fromJson = (j: DetailedJson): PlutusData =>
  j.int !== undefined
    ? { int: BigInt(j.int) }
    : j.bytes !== undefined
      ? { bytes: j.bytes }
      : j.map
        ? { map: j.map.map(({ k, v }) => [fromJson(k), fromJson(v)] as [PlutusData, PlutusData]) }
        : { constr: j.constructor!, fields: j.fields!.map(fromJson) };

describe('pay message', () => {
  it('encodes an ADA payment exactly like the validator serialise', () => {
    expect(
      payInfoCbor({
        merchantAddress: MERCHANT,
        assetUnit: 'lovelace',
        amountBaseUnits: '5000000',
        fundsInRef: `${'11'.repeat(32)}#0`,
      })
    ).toBe(ADA_MSG);
  });

  it('encodes a token payment to an enterprise address (stake None)', () => {
    expect(
      payInfoCbor({
        merchantAddress: ENTERPRISE,
        assetUnit: USDM,
        amountBaseUnits: '1500000',
        fundsInRef: `${'22'.repeat(32)}#3`,
      })
    ).toBe(USDM_MSG);
  });

  it('is the same data the tx builder puts in the Pay redeemer', () => {
    const lucid = { config: () => ({ network: 'Preprod' }) } as unknown as LucidEvolution;
    const payInfo: PayInfoT = {
      amount: assetsToDataPairs({ lovelace: 5_000_000n }),
      merchant_addr: bech32ToAddressType(lucid, MERCHANT),
      ref: { transaction_id: '11'.repeat(32), output_index: 0n },
    };
    const json = CML.decode_plutus_datum_to_json_str(
      CML.PlutusData.from_cbor_hex(Data.to(payInfo, PayInfo)),
      CML.CardanoNodePlutusDatumSchema.DetailedSchema
    );
    expect(plutusCbor(fromJson(JSON.parse(json)))).toBe(ADA_MSG);
  });

  it('accepts the payer signature and rejects anything else', () => {
    expect(verifyPaySignature(PAYER_PK, ADA_MSG, ADA_SIG)).toBe(true);
    expect(verifyPaySignature(PAYER_PK, USDM_MSG, USDM_SIG)).toBe(true);
    expect(verifyPaySignature(OTHER_PK, USDM_MSG, USDM_SIG)).toBe(false);
    expect(verifyPaySignature(PAYER_PK, USDM_MSG, ADA_SIG)).toBe(false);
    expect(verifyPaySignature(PAYER_PK, ADA_MSG, '')).toBe(false);
    expect(verifyPaySignature(PAYER_PK, ADA_MSG, 'zz'.repeat(64))).toBe(false);
    expect(verifyPaySignature('00', ADA_MSG, ADA_SIG)).toBe(false);
  });

  it('refuses reward addresses and malformed funds refs', () => {
    const reward = credentialToRewardAddress('Preprod', { type: 'Key', hash: '0f'.repeat(28) });
    const base = { assetUnit: 'lovelace', amountBaseUnits: '1', fundsInRef: `${'11'.repeat(32)}#0` };
    expect(() => payInfoCbor({ ...base, merchantAddress: reward })).toThrow(/unsupported merchant address/);
    expect(() => payInfoCbor({ ...base, merchantAddress: MERCHANT, fundsInRef: 'abc#0' })).toThrow(/bad fundsInRef/);
  });
});
