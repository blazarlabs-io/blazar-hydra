import { describe, it, expect } from 'vitest';
import { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { Data } from '@lucid-evolution/lucid';
import {
  findFundUtxos,
  assertFundsEmpty,
  assertHeadTokensMatch,
  assertOnlyUserFunds,
  payableInL2,
  fundsOwnerOf,
} from './funds';
import { FundsDatum, FundsDatumT } from './types';
import { BTC_UNIT } from '../../bridge/wanbridge';
import { ASSETS } from '../../shared/payment-contract';

// A real User FundsDatum captured from a live head snapshot (query-funds output).
const USER_FUNDS_DATUM =
  'd8799fd8799fd8799f581c4dd6612d4cc024bad492c30e24e61dff7339a7f49461effb2b6f49b5ffd8799fd8799fd8799f581c32cafcfb14618ffec3b355cef419800df40121871001e2a2bf8a5cccffffffff1a001e8480d8799f58200000000000000000000000000000000000000000000000000000000000000000ffff';
const SCRIPT_ADDR = 'addr_test1wpwsntw7nl0shvxt79qcp7jfpgetgqcuvl5r7angq665pls6fx9ch';
const ADMIN_ADDR = 'addr_test1vqeltkmzgkh9x7yrk0uu7ddj4pvjk3vntkq5uesq0fhtgmsrygxuf';

const utxo = (over: Partial<UTxO>): UTxO => ({
  txHash: 'aa'.repeat(32),
  outputIndex: 0,
  address: SCRIPT_ADDR,
  assets: { lovelace: 2_000_000n },
  datum: null,
  datumHash: null,
  scriptRef: null,
  ...over,
});

describe('findFundUtxos / assertFundsEmpty', () => {
  it('finds UTxOs carrying a FundsDatum', () => {
    const snap = [utxo({ datum: USER_FUNDS_DATUM })];
    expect(findFundUtxos(snap, ADMIN_ADDR)).toHaveLength(1);
  });
  it('ignores admin UTxOs, datum-less UTxOs, and non-FundsDatum datums', () => {
    const snap = [
      utxo({ address: ADMIN_ADDR, datum: USER_FUNDS_DATUM }), // admin -> skip
      utxo({ datum: null }),                                   // no datum -> skip
      utxo({ datum: 'd87980' }),                               // not a FundsDatum -> skip
    ];
    expect(findFundUtxos(snap, ADMIN_ADDR)).toHaveLength(0);
  });
  it('assertFundsEmpty passes on a funds-empty snapshot and throws when funds remain', () => {
    expect(() => assertFundsEmpty([utxo({ address: ADMIN_ADDR, datum: null })], ADMIN_ADDR)).not.toThrow();
    expect(() => assertFundsEmpty([utxo({ datum: USER_FUNDS_DATUM })], ADMIN_ADDR)).toThrow(/not funds-empty/);
  });
});

describe('assertOnlyUserFunds (gate before Close: users leave through the fanout)', () => {
  // Merchant funds carry a validation token minted inside L2; fanning one out would break the
  // head's value conservation (H4), so merchants must be withdrawn before Close.
  const MERCHANT_DATUM =
    'd8799fd8799fd8799f581c2db68687b92bc18aa2240416f5c91aa29be23db115e1b7cebbf85a5dffd8799fd8799fd8799f581c41677a6c1c0dc6adb0f2e2aae96c5cd89e49da016e4e60fa54a12724ffffffff00d87a80ff';

  it('passes when only user funds and admin collateral remain', () => {
    const snap = [utxo({ address: ADMIN_ADDR }), utxo({ datum: USER_FUNDS_DATUM })];
    expect(() => assertOnlyUserFunds(snap, ADMIN_ADDR)).not.toThrow();
  });
  it('throws while merchant funds remain', () => {
    const snap = [utxo({ datum: USER_FUNDS_DATUM }), utxo({ txHash: 'bb'.repeat(32), datum: MERCHANT_DATUM })];
    expect(() => assertOnlyUserFunds(snap, ADMIN_ADDR)).toThrow(/merchant/i);
  });
  it('throws on any other UTxO that is not admin collateral or user funds', () => {
    expect(() => assertOnlyUserFunds([utxo({ datum: null })], ADMIN_ADDR)).toThrow(/aaaa/);
  });
});

describe('assertHeadTokensMatch (gate before Close: the fanout must be able to conserve value)', () => {
  const P = 'cc'.repeat(28); // Blazar validator policy
  const HEAD = 'dd'.repeat(28); // head policy: its tokens are burned by the fanout, not compared
  const t = (n: string) => `${P}${n.repeat(32)}`;

  it('passes when the L1 head output holds exactly the validation tokens of L2', () => {
    const l1 = { lovelace: 84_142_070n, [`${HEAD}4879647261486561645632`]: 1n, [t('01')]: 1n, [t('02')]: 1n };
    const l2 = [utxo({ assets: { lovelace: 30_000_000n, [t('01')]: 1n } }), utxo({ assets: { lovelace: 2_000_000n, [t('02')]: 1n } })];
    expect(() => assertHeadTokensMatch(l1, l2, P)).not.toThrow();
  });
  it('throws on a token burned in L2 but still in the L1 head output (the old user withdraw, H4)', () => {
    const l1 = { lovelace: 52_142_070n, [t('01')]: 1n, [t('02')]: 1n };
    const l2 = [utxo({ assets: { lovelace: 30_000_000n, [t('01')]: 1n } })];
    expect(() => assertHeadTokensMatch(l1, l2, P)).toThrow(new RegExp(t('02')));
  });
  it('throws on a token minted in L2 that the L1 head output does not hold (merchant funds left inside)', () => {
    const l1 = { lovelace: 52_142_070n, [t('01')]: 1n };
    const l2 = [utxo({ assets: { [t('01')]: 1n } }), utxo({ assets: { [t('03')]: 1n } })];
    expect(() => assertHeadTokensMatch(l1, l2, P)).toThrow(new RegExp(t('03')));
  });
});

describe('payableInL2 with bridged BTC', () => {
  it('reports the BTC of a committed deposit; its locked lovelace is not payable (decision 4)', () => {
    const d = Data.from<FundsDatumT>(USER_FUNDS_DATUM, FundsDatum);
    const btcFunds = Data.to<FundsDatumT>({ ...d, locked_deposit: 3_150_770n }, FundsDatum);
    const control = 'cc'.repeat(28) + 'dd'.repeat(32);
    const snap = [
      utxo({ datum: btcFunds, assets: { lovelace: 3_150_770n, [BTC_UNIT]: 199_680n, [control]: 1n } }),
      utxo({ datum: USER_FUNDS_DATUM, assets: { lovelace: 5_000_000n, [control]: 1n } }),
    ];
    expect(payableInL2(snap, (u) => u.startsWith('cc'.repeat(28)))).toEqual({
      [BTC_UNIT]: '199680',
      lovelace: '3000000',
    });
    expect(ASSETS[BTC_UNIT as keyof typeof ASSETS].decimals).toBe(8);
  });
});

describe('fundsOwnerOf (withdraw ownership check)', () => {
  const lucid = { config: () => ({ network: 'Preprod' }) } as unknown as LucidEvolution;
  // Merchant M's live L2 funds UTxO datum (query-funds, 2026-10-10).
  const MERCHANT_DATUM =
    'd8799fd8799fd8799f581c2db68687b92bc18aa2240416f5c91aa29be23db115e1b7cebbf85a5dffd8799fd8799fd8799f581c41677a6c1c0dc6adb0f2e2aae96c5cd89e49da016e4e60fa54a12724ffffffff00d87a80ff';
  const M =
    'addr_test1qqkmdp58hy4urz4zyszpdawfr23fhc3aky27rd7wh0u95h2pvaaxc8qdc6kmpuhz4t5kchxcneya5qtwfes0549pyujqveuc6j';

  it('returns the datum address in bech32, null without a FundsDatum', () => {
    expect(fundsOwnerOf(lucid, utxo({ datum: MERCHANT_DATUM }))).toBe(M);
    expect(fundsOwnerOf(lucid, utxo({ datum: USER_FUNDS_DATUM }))).not.toBe(M);
    expect(fundsOwnerOf(lucid, utxo({ datum: null }))).toBeNull();
    expect(fundsOwnerOf(lucid, utxo({ datum: 'd87980' }))).toBeNull();
  });
});
