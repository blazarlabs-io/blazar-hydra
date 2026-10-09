import { describe, it, expect } from 'vitest';
import { UTxO } from '@lucid-evolution/lucid';
import { findFundUtxos, assertFundsEmpty } from './funds';

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
