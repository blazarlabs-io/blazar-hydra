import { describe, it, expect } from 'vitest';
import {
  ASSETS,
  CreatePaymentSchema,
  formatBaseUnits,
  NEXT_STATES,
  PaymentStateSchema,
  TERMINAL_STATES,
  toBaseUnits,
} from './payment-contract';

const USDM = '77484e67c1ed6c96f55b89206cb5d6caae9a09a0bd473bba817929fe5553444d';
const BTC = 'd2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af425443';

describe('payment contract self-check', () => {
  it('asset decimals: ADA 6, USDM 6 (no on-chain metadata), BTC 8', () => {
    expect(ASSETS.lovelace.decimals).toBe(6);
    expect(ASSETS[USDM].decimals).toBe(6);
    expect(ASSETS[BTC].decimals).toBe(8);
  });

  it('toBaseUnits converts exactly', () => {
    expect(toBaseUnits('1.5', 6)).toBe('1500000');
    expect(toBaseUnits('0.000001', 6)).toBe('1');
    expect(toBaseUnits(' 2 ', 6)).toBe('2000000');
    expect(toBaseUnits('0.00000001', 8)).toBe('1');
    expect(toBaseUnits('7', 0)).toBe('7');
    expect(toBaseUnits('9999999999999.999999', 6)).toBe('9999999999999999999');
  });

  it.each([
    ['1.0000001', 6], // excess decimals
    ['-1', 6],
    ['1e3', 6],
    ['0', 6],
    ['0.000000', 6],
    ['', 6],
    ['abc', 6],
    ['10000000000000', 6], // 1e19 base units: out of u64 range of the schema
  ])('toBaseUnits rejects %j', (human, d) => {
    expect(() => toBaseUnits(human as string, d as number)).toThrow();
  });

  it('formatBaseUnits and a round trip for every asset', () => {
    expect(formatBaseUnits('1500000', 6)).toBe('1.5');
    expect(formatBaseUnits('1', 8)).toBe('0.00000001');
    expect(formatBaseUnits('100000000', 8)).toBe('1');
    for (const { decimals } of Object.values(ASSETS)) {
      for (const human of ['1', '0.5', '123.000001']) {
        expect(formatBaseUnits(toBaseUnits(human, decimals), decimals)).toBe(
          human
        );
      }
    }
  });

  it('CreatePaymentSchema accepts strings in base units only', () => {
    const ok = {
      merchantAddress: 'addr_test1x',
      assetUnit: USDM,
      amountBaseUnits: '2500000',
    };
    expect(CreatePaymentSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, amountBaseUnits: 2500000 },
      { ...ok, amountBaseUnits: BigInt(2500000) }, // what json-bigint makes of a JSON number
      { ...ok, amountBaseUnits: '0' },
      { ...ok, amountBaseUnits: '01' },
      { ...ok, amountBaseUnits: '1.5' },
      { ...ok, assetUnit: 'deadbeef' },
      { ...ok, extra: 1 }, // strict
    ]) {
      expect(CreatePaymentSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('terminal states are final and transitions stay inside the state set', () => {
    for (const s of TERMINAL_STATES) expect(NEXT_STATES[s]).toEqual([]);
    for (const targets of Object.values(NEXT_STATES)) {
      for (const t of targets)
        expect(PaymentStateSchema.safeParse(t).success).toBe(true);
    }
    expect(NEXT_STATES.created).not.toContain('submitted'); // authorize is mandatory
  });
});
