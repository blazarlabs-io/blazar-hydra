import { describe, expect, it } from 'vitest';
import { UTxO } from '@lucid-evolution/lucid';
import { payOutOnL1, takeUserFundsOut, UserFundsOps } from './user-funds';

const USER_FUNDS_DATUM =
  'd8799fd8799fd8799f581c4dd6612d4cc024bad492c30e24e61dff7339a7f49461effb2b6f49b5ffd8799fd8799fd8799f581c32cafcfb14618ffec3b355cef419800df40121871001e2a2bf8a5cccffffffff1a001e8480d8799f58200000000000000000000000000000000000000000000000000000000000000000ffff';
const MERCHANT_DATUM =
  'd8799fd8799fd8799f581c2db68687b92bc18aa2240416f5c91aa29be23db115e1b7cebbf85a5dffd8799fd8799fd8799f581c41677a6c1c0dc6adb0f2e2aae96c5cd89e49da016e4e60fa54a12724ffffffff00d87a80ff';
const fund = (tx: string, datum = USER_FUNDS_DATUM): UTxO => ({
  txHash: tx.repeat(32),
  outputIndex: 0,
  address: 'addr_test1wpwsntw7nl0shvxt79qcp7jfpgetgqcuvl5r7angq665pls6fx9ch',
  assets: { lovelace: 30_000_000n },
  datum,
});

function recordingOps(calls: string[]): UserFundsOps {
  return {
    decommitIntact: async (u) => {
      calls.push(`decommit ${u.txHash.slice(0, 2)}`);
    },
    findOnL1: async (u) => {
      calls.push(`find ${u.txHash.slice(0, 2)}`);
      return { ...u, txHash: 'f'.repeat(62) + u.txHash.slice(0, 2) };
    },
    withdrawOnL1: async (us) => {
      calls.push(`withdraw ${us.map((u) => u.txHash.slice(-2)).join(',')}`);
      return { txHash: 'cd'.repeat(32), cborHex: '84' };
    },
  };
}

describe('user funds leave the head without burning their L1 token in L2', () => {
  it('decommits each UTxO intact, then pays every owner from L1', async () => {
    const calls: string[] = [];
    const paid = await takeUserFundsOut(recordingOps(calls), [fund('a1'), fund('b2')]);
    expect(calls).toEqual(['decommit a1', 'decommit b2', 'find a1', 'find b2', 'withdraw a1,b2']);
    expect(paid.map((p) => p.txHash)).toEqual(['cd'.repeat(32)]);
  });

  it('refuses merchant funds: their token was minted in L2 and cannot leave the head intact', async () => {
    const calls: string[] = [];
    await expect(takeUserFundsOut(recordingOps(calls), [fund('a1'), fund('c3', MERCHANT_DATUM)])).rejects.toThrow(
      /merchant/i
    );
    expect(calls).toEqual([]);
  });

  it('after a fanout only pays out from L1, in batches small enough for one transaction', async () => {
    const calls: string[] = [];
    const funds = Array.from({ length: 12 }, (_, i) => fund((10 + i).toString()));
    const paid = await payOutOnL1(recordingOps(calls), funds);
    expect(calls.filter((c) => c.startsWith('decommit'))).toEqual([]);
    expect(calls.filter((c) => c.startsWith('withdraw'))).toEqual([
      'withdraw 10,11,12,13,14,15,16,17,18,19',
      'withdraw 20,21',
    ]);
    expect(paid).toHaveLength(2);
  });
});
