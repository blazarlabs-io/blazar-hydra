import { describe, expect, it } from 'vitest';
import { credentialToAddress } from '@lucid-evolution/lucid';
import {
  applyEvent,
  assertDepositDestination,
  BTC_UNIT,
  btcToSats,
  decodeMemo,
  Deposit,
  DepositTransitionError,
  findBtcDeposit,
  isTestnetApiUrl,
  parseBtcTx,
  parseCreateTx2,
  parseKoiosTx,
  parseQuotaAndFee,
  parseStatus,
  parseTokenPair,
  satsToBtc,
  verifyCardanoArrival,
  verifyMemo,
} from '.';
// Real responses recorded from the live testnet APIs (see docs/bridge-spike.md, docs/bridge-integration.md).
import createTx2Fx from './__fixtures__/createTx2-spike.json';
import tokenPairsFx from './__fixtures__/tokenPairs-517.json';
import quotaFx from './__fixtures__/quotaAndFee-517.json';
import statusSuccessFx from './__fixtures__/status-success.json';
import statusNotFoundFx from './__fixtures__/status-notfound.json';
import mempoolTxFx from './__fixtures__/mempool-tx-6633762d.json';
import koiosTxFx from './__fixtures__/koios-tx_info-b142c3c9.json';

// ADMIN_ADDRESS from the hydra-pay ConfigMap: destination of the spike createTx2 (2026-10-09).
const ADMIN =
  'addr_test1qzl4ugvgu920q4lr86lydvfqstm42arezeyjm0wy8mujvm93dzr5pcgc37ym773c8w6q5uem08ts6qskrvc6mw6nvf4s4tu94z';
const SPIKE_MEMO = createTx2Fx.data.tx.memo;
// Historic pair-517 deposit (2026-01-12): BTC tx 6633762d… -> Cardano tx b142c3c9…
const HIST_TXID =
  '6633762d996f7932d159f76573c388c4282e8ea7ee7dfa6e7eda1579f67cf890';
const HIST_REDEEM =
  'b142c3c995e8f3c8d630fb0eda8673f55d1b8e2432dfee154255454cb1075abc';
const HIST_DEST =
  'addr_test1qr2ure5s9pg3ancpwfwhtcwgzeaktepk8nk8sep0yc9gff636vajy85w3dl7xprneqftdxzzqw6ywh3ht0gz3nkaj0uqkmdz5f';
const HIST_DEPOSIT_ADDR =
  'tb1pw57f48hne57cyqr9j9dqapj4h2h48ks7paee9w8nal0lyx2qcm4qpvnmvy';
const HIST_MEMO = mempoolTxFx.vout[1].scriptpubkey.slice(4); // strip 6a44

describe('amount conversion', () => {
  it.each([
    [0n, '0'],
    [1n, '0.00000001'],
    [32n, '0.00000032'],
    [50_000n, '0.0005'],
    [49_900n, '0.000499'],
    [100_000_000n, '1'],
    [123_456_789n, '1.23456789'],
    [2_100_000_000_000_000n, '21000000'],
  ])('%s sats <-> "%s"', (sats, btc) => {
    expect(satsToBtc(sats)).toBe(btc);
    expect(btcToSats(btc)).toBe(sats);
  });

  it('accepts trailing zeros past 8 decimals, rejects sub-sat precision', () => {
    expect(btcToSats('0.000000010')).toBe(1n);
    expect(() => btcToSats('0.000000001')).toThrow(/1 sat/);
  });

  it.each(['', '-1', '.5', '1.', '1e-8', '0,5', ' 1', '0x1'])(
    'rejects "%s"',
    (s) => {
      expect(() => btcToSats(s)).toThrow(RangeError);
    }
  );

  it('rejects negative sats', () => {
    expect(() => satsToBtc(-1n)).toThrow(RangeError);
  });
});

describe('testnet guard', () => {
  it('accepts only the testnet API', () => {
    expect(isTestnetApiUrl('https://bridge-api.wanchain.org/api/testnet')).toBe(
      true
    );
    expect(
      isTestnetApiUrl('https://bridge-api.wanchain.org/api/testnet/')
    ).toBe(true);
    expect(isTestnetApiUrl('https://bridge-api.wanchain.org/api')).toBe(false);
    expect(isTestnetApiUrl('https://bridge-api.wanchain.org/api/')).toBe(false);
    expect(isTestnetApiUrl('not a url')).toBe(false);
  });
});

describe('memo', () => {
  it('decodes the spike memo to ADMIN_ADDRESS', () => {
    expect(verifyMemo(SPIKE_MEMO, ADMIN)).toEqual({
      type: 7,
      tokenPairId: 517,
      reserved: '0000000000000000',
      addressHex:
        '00bf5e2188e154f057e33ebe46b12082f755747916492dbdc43ef9266cb1688740e1188f89bf7a383bb40a733b79d70d02161b31adbb53626b',
    });
  });

  it('decodes the on-chain memo of a historic pair-517 deposit to its real destination', () => {
    expect(verifyMemo(HIST_MEMO, HIST_DEST).tokenPairId).toBe(517);
  });

  it('rejects another destination', () => {
    expect(() => verifyMemo(SPIKE_MEMO, HIST_DEST)).toThrow(/expected/);
  });

  it('rejects a wrong type, pair, non-zero reserved bytes, 0x prefix or odd hex', () => {
    expect(() => verifyMemo('08' + SPIKE_MEMO.slice(2), ADMIN)).toThrow(/type/);
    expect(() => verifyMemo('070206' + SPIKE_MEMO.slice(6), ADMIN)).toThrow(
      /tokenPair/
    );
    expect(() =>
      verifyMemo(SPIKE_MEMO.slice(0, 21) + '1' + SPIKE_MEMO.slice(22), ADMIN)
    ).toThrow(/reserved/);
    expect(() => decodeMemo('0x' + SPIKE_MEMO)).toThrow();
    expect(() => decodeMemo(SPIKE_MEMO + '0')).toThrow();
  });
});

describe('destination guard', () => {
  it('accepts a preprod base key address', () => {
    expect(() => assertDepositDestination(ADMIN)).not.toThrow();
  });

  it('rejects mainnet, enterprise and script addresses', () => {
    const pay = {
      type: 'Key' as const,
      hash: 'bf5e2188e154f057e33ebe46b12082f755747916492dbdc43ef9266c',
    };
    const stake = {
      type: 'Key' as const,
      hash: 'b1688740e1188f89bf7a383bb40a733b79d70d02161b31adbb53626b',
    };
    expect(() =>
      assertDepositDestination(credentialToAddress('Mainnet', pay, stake))
    ).toThrow();
    expect(() =>
      assertDepositDestination(credentialToAddress('Preprod', pay))
    ).toThrow();
    const script = koiosTxFx[0].outputs.find((o) => o.tx_index === 1)!
      .payment_addr.bech32;
    expect(() => assertDepositDestination(script)).toThrow();
  });
});

describe('API response parsing', () => {
  it('tokenPair 517 is BTC(8) -> ADA(8) minting BTC_UNIT', () => {
    expect(parseTokenPair(tokenPairsFx).tokenPairID).toBe('517');
    const changed = structuredClone(tokenPairsFx);
    changed.data[0].toToken.decimals = '6';
    expect(() => parseTokenPair(changed)).toThrow(/changed/);
    expect(() => parseTokenPair({ success: true, data: [] })).toThrow(
      /not listed/
    );
  });

  it('quotaAndFee limits are BigInt sats', () => {
    const q = parseQuotaAndFee(quotaFx);
    expect(q.minQuota).toBe(32n);
    expect(q.operationFee).toMatchObject({
      value: '0.002',
      minFeeLimit: 16n,
      maxFeeLimit: 320n,
    });
  });

  it('createTx2 gives exact sats and a verified memo', () => {
    expect(
      parseCreateTx2(createTx2Fx, { toAccount: ADMIN, amountSats: 50_000n })
    ).toEqual({
      depositAddress:
        'tb1p3l2xzu3lpz68c8ml5qydml44g8vu23q5wjl62cujngyh8xacr5pqyylxef',
      valueSats: 50_000n,
      memo: SPIKE_MEMO,
      receiveSats: 49_900n,
    });
  });

  it('createTx2 rejects a value echo mismatch, a foreign memo and an API error', () => {
    expect(() =>
      parseCreateTx2(createTx2Fx, { toAccount: ADMIN, amountSats: 10_000n })
    ).toThrow(/value/);
    expect(() =>
      parseCreateTx2(createTx2Fx, { toAccount: HIST_DEST, amountSats: 50_000n })
    ).toThrow(/expected/);
    expect(() =>
      parseCreateTx2(
        { success: false, error: 'Input params not correct' },
        { toAccount: ADMIN, amountSats: 1n }
      )
    ).toThrow(/Input params not correct/);
  });

  it('status NotFound comes as success:false with data "NotFound"', () => {
    expect(parseStatus(statusNotFoundFx, HIST_TXID)).toEqual({
      status: 'NotFound',
    });
  });

  it('status Success carries redeemHash and BigInt amounts', () => {
    expect(parseStatus(statusSuccessFx, HIST_TXID)).toEqual({
      status: 'Success',
      redeemHash: HIST_REDEEM,
      sendAmount: 200_000n,
      receiveAmount: 199_680n,
    });
    expect(
      parseStatus(statusSuccessFx, '0x' + HIST_TXID.toUpperCase()).status
    ).toBe('Success');
  });

  it('status rejects another txid, another pair, and Success without redeemHash', () => {
    expect(() => parseStatus(statusSuccessFx, 'ab'.repeat(32))).toThrow(
      /lockHash/
    );
    const other = structuredClone(statusSuccessFx);
    other.data.tokenPair = '15';
    expect(() => parseStatus(other, HIST_TXID)).toThrow(/tokenPair/);
    const noRedeem = {
      ...statusSuccessFx,
      data: { ...statusSuccessFx.data, redeemHash: null },
    };
    expect(() => parseStatus(noRedeem, HIST_TXID)).toThrow(/redeemHash/);
  });

  it('status Processing (shape per API docs, redeemHash null)', () => {
    const processing = {
      ...statusSuccessFx,
      data: { ...statusSuccessFx.data, status: 'Processing', redeemHash: null },
    };
    expect(parseStatus(processing, HIST_TXID)).toEqual({
      status: 'Processing',
    });
  });
});

describe('Bitcoin deposit output', () => {
  it('finds the vout paying the storeman address and the exact memo', () => {
    expect(
      findBtcDeposit(parseBtcTx(mempoolTxFx), {
        depositAddress: HIST_DEPOSIT_ADDR,
        memo: HIST_MEMO,
      })
    ).toEqual({
      ok: true,
      vout: 0,
      valueSats: 200_000n,
      confirmed: true,
    });
  });

  it('flags a missing memo or a wrong deposit address', () => {
    expect(
      findBtcDeposit(parseBtcTx(mempoolTxFx), {
        depositAddress: HIST_DEPOSIT_ADDR,
        memo: SPIKE_MEMO,
      })
    ).toEqual({
      ok: false,
      reason: 'MEMO_MISSING',
    });
    expect(
      findBtcDeposit(parseBtcTx(mempoolTxFx), {
        depositAddress: createTx2Fx.data.tx.toAccount,
        memo: HIST_MEMO,
      })
    ).toEqual({ ok: false, reason: 'NO_OUTPUT_TO_DEPOSIT_ADDRESS' });
  });
});

describe('Cardano arrival', () => {
  const tx = parseKoiosTx(koiosTxFx);
  const expected = {
    redeemHash: HIST_REDEEM,
    destination: HIST_DEST,
    unit: BTC_UNIT,
    btcTxid: HIST_TXID,
  };

  it('returns the outRef and quantity of the bridged BTC output', () => {
    expect(verifyCardanoArrival(tx, expected)).toEqual({
      ok: true,
      outRef: { txHash: HIST_REDEEM, outputIndex: 0 },
      quantity: 199_680n,
      lovelace: 1_150_770n,
    });
  });

  it('rejects a missing tx, another BTC txid, another destination, another unit', () => {
    expect(verifyCardanoArrival(parseKoiosTx([]), expected)).toEqual({
      ok: false,
      reason: 'TX_NOT_FOUND',
    });
    expect(
      verifyCardanoArrival(tx, { ...expected, btcTxid: 'ab'.repeat(32) })
    ).toMatchObject({
      reason: 'METADATA_MISMATCH',
    });
    expect(
      verifyCardanoArrival(tx, { ...expected, destination: ADMIN })
    ).toMatchObject({
      reason: 'NO_MATCHING_OUTPUT',
    });
    expect(
      verifyCardanoArrival(tx, { ...expected, unit: BTC_UNIT.slice(0, -2) })
    ).toMatchObject({
      reason: 'NO_MATCHING_OUTPUT',
    });
  });
});

describe('deposit state machine', () => {
  const t0 = new Date('2026-10-10T10:00:00Z');
  const sent: Deposit = applyEvent<Deposit>(
    { state: 'CREATED' },
    { type: 'BTC_SENT', btcTxid: HIST_TXID, vout: 0, at: t0 }
  );
  const success = {
    type: 'BRIDGE_STATUS',
    status: parseStatus(statusSuccessFx, HIST_TXID),
  } as const;
  const l1 = {
    type: 'L1_VERIFIED',
    outRef: { txHash: HIST_REDEEM, outputIndex: 0 },
    quantity: 199_680n,
  } as const;
  const status = (s: 'NotFound' | 'Processing' | 'Trusteeship' | 'Refund') =>
    ({ type: 'BRIDGE_STATUS', status: { status: s } }) as const;
  const tick = (ms: number) =>
    ({
      type: 'TICK',
      now: new Date(t0.getTime() + ms),
      timeoutMs: 7_200_000,
    }) as const;

  it('walks the happy path to AVAILABLE_L2', () => {
    let d = applyEvent(sent, status('NotFound'));
    expect(d).toBe(sent);
    d = applyEvent(d, status('Processing'));
    expect(d.state).toBe('BRIDGE_PROCESSING');
    d = applyEvent(d, success);
    expect(d).toMatchObject({
      state: 'BRIDGE_PROCESSING',
      redeemHash: HIST_REDEEM,
    });
    d = applyEvent(d, l1);
    expect(d).toMatchObject({
      state: 'L1_CONFIRMED',
      l1OutputIndex: 0,
      l1Quantity: 199_680n,
    });
    d = applyEvent(d, { type: 'COMMIT_STARTED', commitTxId: 'c1' });
    d = applyEvent(d, { type: 'COMMIT_CONFIRMED', commitTxId: 'c1' });
    expect(d.state).toBe('AVAILABLE_L2');
  });

  it('is idempotent: repeated inputs return the same object', () => {
    const s1 = applyEvent(sent, success);
    expect(applyEvent(s1, success)).toBe(s1);
    expect(applyEvent(s1, status('Processing'))).toBe(s1);
    expect(
      applyEvent(s1, {
        type: 'BTC_SENT',
        btcTxid: HIST_TXID,
        vout: 0,
        at: new Date(),
      })
    ).toBe(s1);
    const c = applyEvent(s1, l1);
    expect(applyEvent(c, l1)).toBe(c);
    expect(applyEvent(c, success)).toBe(c);
    const a = applyEvent(
      applyEvent(c, { type: 'COMMIT_STARTED', commitTxId: 'c1' }),
      {
        type: 'COMMIT_CONFIRMED',
        commitTxId: 'c1',
      }
    );
    expect(applyEvent(a, { type: 'COMMIT_CONFIRMED', commitTxId: 'c1' })).toBe(
      a
    );
    expect(applyEvent(a, l1)).toBe(a);
  });

  it('throws on conflicting data', () => {
    const s1 = applyEvent(sent, success);
    const otherSuccess = {
      type: 'BRIDGE_STATUS',
      status: { ...success.status, redeemHash: 'cd'.repeat(32) },
    } as const;
    expect(() => applyEvent(s1, otherSuccess)).toThrow(DepositTransitionError);
    expect(() =>
      applyEvent(sent, {
        type: 'BTC_SENT',
        btcTxid: HIST_TXID,
        vout: 1,
        at: t0,
      })
    ).toThrow(DepositTransitionError);
    const c = applyEvent(s1, l1);
    expect(() => applyEvent(c, { ...l1, quantity: 1n })).toThrow(
      DepositTransitionError
    );
    expect(() => applyEvent(s1, status('Refund'))).toThrow(/contradicts/);
  });

  it('is forward-only', () => {
    expect(() =>
      applyEvent<Deposit>({ state: 'CREATED' }, status('Processing'))
    ).toThrow(/before BTC_SENT/);
    expect(() => applyEvent(sent, l1)).toThrow(DepositTransitionError);
    expect(() =>
      applyEvent(sent, { type: 'COMMIT_STARTED', commitTxId: 'c1' })
    ).toThrow(DepositTransitionError);
    const p = applyEvent(sent, status('Processing'));
    expect(applyEvent(p, status('NotFound'))).toBe(p);
  });

  it('times out only the bridge leg, and a late Success recovers', () => {
    expect(applyEvent(sent, tick(7_200_000))).toBe(sent);
    const timedOut = applyEvent(sent, tick(7_200_001));
    expect(timedOut.state).toBe('TIMEOUT');
    expect(applyEvent(timedOut, status('Processing'))).toBe(timedOut);
    const late = applyEvent(timedOut, success);
    expect(late.state).toBe('BRIDGE_PROCESSING');
    expect(applyEvent(late, tick(99_000_000))).toBe(late);
  });

  it('Trusteeship can still end in Success or Refund; Refund is final', () => {
    const tr = applyEvent(sent, status('Trusteeship'));
    expect(tr.state).toBe('TRUSTEESHIP');
    expect(applyEvent(tr, status('Trusteeship'))).toBe(tr);
    expect(applyEvent(tr, success).state).toBe('BRIDGE_PROCESSING');
    const rf = applyEvent(tr, status('Refund'));
    expect(rf.state).toBe('REFUND');
    expect(applyEvent(rf, status('Refund'))).toBe(rf);
    expect(() => applyEvent(rf, success)).toThrow(DepositTransitionError);
  });
});
