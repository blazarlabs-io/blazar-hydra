import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialToAddress, UTxO } from '@lucid-evolution/lucid';
import { Prisma } from '@prisma/client';
import { randomBytes, randomUUID } from 'crypto';
import { env, prisma } from '../../config';
import {
  BridgeStatus,
  BTC_UNIT,
  KoiosTx,
  parseBtcTx,
  parseKoiosTx,
  parseQuotaAndFee,
  parseStatus,
} from '../../bridge/wanbridge';
import mempoolFx from '../../bridge/wanbridge/__fixtures__/mempool-tx-6633762d.json';
import statusFx from '../../bridge/wanbridge/__fixtures__/status-success.json';
import koiosFx from '../../bridge/wanbridge/__fixtures__/koios-tx_info-b142c3c9.json';
import quotaFx from '../../bridge/wanbridge/__fixtures__/quotaAndFee-517.json';
import { DepositSchema } from '../../shared/payment-contract';
import { DBStatus } from '../../shared/prisma-schemas';
import { CommitOutcome } from '../lib/hydra';
import {
  attachBtcTx,
  BRIDGE_TIMEOUT_MS,
  COMMIT_WAIT_MS,
  createBtcDeposit,
  DepositDeps,
  pollDeposits,
  readDeposit,
  singleFlight,
  toDepositDto,
} from './btc-deposit';
import { withLock } from './execute-payment';

// The recorded pair-517 deposit: BTC tx 6633762d… -> Cardano redeem b142c3c9…#0 (199680 units).
const BTC_TXID = mempoolFx.txid;
const BTC_TO = mempoolFx.vout[0].scriptpubkey_address;
const MEMO = mempoolFx.vout[1].scriptpubkey.slice(4); // strip OP_RETURN 6a44
const REDEEM = statusFx.data.redeemHash;
const btcTx = parseBtcTx(mempoolFx);
const success = parseStatus(statusFx, BTC_TXID);
const koiosTx = parseKoiosTx(koiosFx)!;

const USER = {
  id: randomUUID(),
  address: credentialToAddress(
    'Preprod',
    { type: 'Key', hash: 'a1'.repeat(28) },
    { type: 'Key', hash: '0f'.repeat(28) }
  ),
};
const FUNDS_UNIT = 'cc'.repeat(28) + 'dd'.repeat(32);
const FUNDS: UTxO = {
  txHash: 'f1'.repeat(32),
  outputIndex: 0,
  address: credentialToAddress('Preprod', {
    type: 'Script',
    hash: 'ee'.repeat(28),
  }),
  assets: { lovelace: 3_150_770n, [BTC_UNIT]: 199_680n, [FUNDS_UNIT]: 1n },
  datum: null,
};
const hex32 = () => randomBytes(32).toString('hex');
const status = (s: BridgeStatus) => async () => s;

function fakeDeps() {
  return {
    bridge: {
      getQuotaAndFee: vi.fn(async () => parseQuotaAndFee(quotaFx)),
      createTx2: vi.fn(async () => ({
        depositAddress: BTC_TO!,
        valueSats: 200_000n,
        memo: MEMO,
        receiveSats: 199_680n,
      })),
      fetchBtcTx: vi.fn(async () => btcTx),
      getStatus: vi.fn(async (): Promise<BridgeStatus> => success),
      fetchKoiosTx: vi.fn(async (): Promise<KoiosTx | undefined> => koiosTx),
    },
    snapshot: vi.fn(async (): Promise<UTxO[]> => []),
    fundsUtxo: vi.fn(async () => ({ utxo: FUNDS, unit: FUNDS_UNIT })),
    submitCommit: vi.fn(
      async (_funds: UTxO, beforeSubmit: (id: string) => Promise<void>) => {
        const id = hex32();
        await beforeSubmit(id);
        return id;
      }
    ),
    awaitCommit: vi.fn(async (): Promise<CommitOutcome> => 'finalized'),
    recover: vi.fn(async () => {}),
  } satisfies DepositDeps;
}

const row = (id: string) => prisma.deposit.findUniqueOrThrow({ where: { id } });
const newDeposit = (data: Partial<Prisma.DepositUncheckedCreateInput> = {}) =>
  prisma.deposit.create({
    data: {
      userId: USER.id,
      userAddress: USER.address,
      assetUnit: BTC_UNIT,
      requestedBaseUnits: '200000',
      btcToAccount: BTC_TO!,
      btcValueSats: '200000',
      btcMemo: MEMO,
      expiresAt: new Date(Date.now() + 60_000),
      ...data,
    },
  });
const sent = (data: Partial<Prisma.DepositUncheckedCreateInput> = {}) =>
  newDeposit({
    state: 'btc_sent',
    btcTxid: BTC_TXID,
    btcVout: 0,
    btcSentAt: new Date(),
    ...data,
  });
const confirmedOnL1 = (
  data: Partial<Prisma.DepositUncheckedCreateInput> = {}
) =>
  sent({
    state: 'l1_confirmed',
    redeemTxHash: REDEEM,
    redeemIndex: 0,
    receivedBaseUnits: '199680',
    ...data,
  });

beforeAll(async () => {
  await prisma.process.create({ data: { status: DBStatus.RUNNING } });
});
beforeEach(async () => {
  await prisma.deposit.deleteMany();
});

describe('POST /deposits/btc', () => {
  it('creates createTx2 instructions for DEPOSIT_ADDRESS, valid for 30 min', async () => {
    const deps = fakeDeps();
    const r = await createBtcDeposit(USER, 200_000n, deps);
    expect(r.status).toBe(201);
    if (r.status !== 201) return;
    expect(deps.bridge.createTx2).toHaveBeenCalledWith({
      fromAccount: env.BRIDGE_PLACEHOLDER_FROM,
      toAccount: env.DEPOSIT_ADDRESS,
      amountSats: 200_000n,
    });
    const dto = DepositSchema.parse(toDepositDto(r.deposit));
    expect(dto).toMatchObject({
      state: 'created',
      assetUnit: BTC_UNIT,
      requestedBaseUnits: '200000',
      btc: { toAccount: BTC_TO, valueSats: '200000', memo: MEMO },
      btcTxid: null,
    });
    const ttl = Date.parse(dto.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);
  });

  it('refuses amounts outside the bridge quota (422) and a down bridge (502)', async () => {
    const deps = fakeDeps();
    expect(await createBtcDeposit(USER, 31n, deps)).toEqual({
      status: 422,
      error: 'AMOUNT_OUT_OF_RANGE',
    });
    deps.bridge.createTx2.mockRejectedValueOnce(new Error('HTTP 500'));
    expect(await createBtcDeposit(USER, 50_000n, deps)).toEqual({
      status: 502,
      error: 'BRIDGE_UNAVAILABLE',
    });
    expect(await prisma.deposit.count()).toBe(0);
  });
});

describe('POST /deposits/:id/btc-tx', () => {
  it('accepts the tx paying exactly toAccount, value and memo; a repeat is a no-op', async () => {
    const deps = fakeDeps();
    const d = await newDeposit();
    const r = await attachBtcTx(d.id, USER.id, BTC_TXID, deps);
    expect(r.status).toBe(200);
    expect(await row(d.id)).toMatchObject({
      state: 'btc_sent',
      btcTxid: BTC_TXID,
      btcVout: 0,
    });
    expect((await attachBtcTx(d.id, USER.id, BTC_TXID, deps)).status).toBe(200);
    expect((await attachBtcTx(d.id, USER.id, hex32(), deps)).status).toBe(409);
    expect(deps.bridge.fetchBtcTx).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'memo missing',
      { ...btcTx, vout: [btcTx.vout[0], btcTx.vout[2]] },
      {},
      'MEMO_MISSING',
    ],
    [
      'memo for another destination',
      btcTx,
      { btcMemo: MEMO.slice(0, -2) + '00' },
      'MEMO_MISSING',
    ],
    ['another amount', btcTx, { btcValueSats: '199999' }, 'VALUE_MISMATCH'],
  ])(
    '%s: 422 + needs_attention, tracked and never credited',
    async (_n, tx, data, error) => {
      const deps = fakeDeps();
      deps.bridge.fetchBtcTx.mockResolvedValue(tx);
      const d = await newDeposit(data);
      expect(await attachBtcTx(d.id, USER.id, BTC_TXID, deps)).toMatchObject({
        status: 422,
        error,
      });
      expect(await row(d.id)).toMatchObject({
        state: 'needs_attention',
        btcTxid: BTC_TXID,
        error,
      });
      expect((await attachBtcTx(d.id, USER.id, BTC_TXID, deps)).status).toBe(
        422
      ); // same answer on repeat
      await pollDeposits(deps);
      expect(deps.bridge.getStatus).not.toHaveBeenCalled();
      expect((await row(d.id)).state).toBe('needs_attention');
    }
  );

  it('a tx that does not pay toAccount, or is not found, changes nothing', async () => {
    const deps = fakeDeps();
    const d = await newDeposit({
      btcToAccount: 'tb1qapnye2f5fjddqaguz4q7klhhtv2cqr5qgkc0pu' + 'x',
    });
    expect(await attachBtcTx(d.id, USER.id, BTC_TXID, deps)).toMatchObject({
      status: 422,
      error: 'NO_OUTPUT_TO_DEPOSIT_ADDRESS',
    });
    deps.bridge.fetchBtcTx.mockRejectedValueOnce(new Error('not found'));
    expect(await attachBtcTx(d.id, USER.id, hex32(), deps)).toMatchObject({
      status: 422,
      error: 'BTC_TX_NOT_FOUND',
    });
    expect(await row(d.id)).toMatchObject({ state: 'created', btcTxid: null });
  });

  it('one BTC output funds one deposit: a second claim gets 409', async () => {
    const deps = fakeDeps();
    const [a, b] = [await newDeposit(), await newDeposit()];
    expect((await attachBtcTx(a.id, USER.id, BTC_TXID, deps)).status).toBe(200);
    expect(await attachBtcTx(b.id, USER.id, BTC_TXID, deps)).toMatchObject({
      status: 409,
      error: 'BTC_TX_ALREADY_CLAIMED',
    });
    expect(await row(b.id)).toMatchObject({ state: 'created', btcTxid: null });
  });

  it("another user's deposit is 404; an expired one still takes a tx that verifies", async () => {
    const deps = fakeDeps();
    const d = await newDeposit({ expiresAt: new Date(Date.now() - 1) });
    expect((await attachBtcTx(d.id, randomUUID(), BTC_TXID, deps)).status).toBe(
      404
    );
    expect(await readDeposit(d.id, USER.id)).toMatchObject({
      state: 'expired',
      error: 'EXPIRED',
    });
    expect((await attachBtcTx(d.id, USER.id, BTC_TXID, deps)).status).toBe(200);
    expect(await row(d.id)).toMatchObject({ state: 'btc_sent', error: null });
  });
});

describe('poller: bridge leg', () => {
  it('NotFound -> Processing -> Success (not in a block yet) -> Koios verified -> l1_confirmed', async () => {
    const deps = fakeDeps();
    deps.fundsUtxo.mockRejectedValue(new Error('L1 down')); // stop at l1_confirmed
    const d = await sent();

    deps.bridge.getStatus.mockImplementationOnce(
      status({ status: 'NotFound' })
    );
    await pollDeposits(deps);
    expect((await row(d.id)).state).toBe('btc_sent');

    deps.bridge.getStatus.mockImplementationOnce(
      status({ status: 'Processing' })
    );
    await pollDeposits(deps);
    expect((await row(d.id)).state).toBe('bridge_processing');

    deps.bridge.fetchKoiosTx.mockResolvedValueOnce({
      ...koiosTx,
      block_height: null,
    });
    await pollDeposits(deps);
    expect(await row(d.id)).toMatchObject({
      state: 'bridge_processing',
      redeemTxHash: REDEEM,
      redeemIndex: null,
    });

    await pollDeposits(deps);
    const l1 = await row(d.id);
    expect(l1).toMatchObject({
      state: 'l1_confirmed',
      receivedBaseUnits: '199680',
    });
    expect(toDepositDto(l1).l1Ref).toBe(`${REDEEM}#0`);
    expect(l1.error).toMatch(/^COMMIT_NOT_STARTED/);
    expect(deps.bridge.fetchKoiosTx).toHaveBeenCalledWith(REDEEM);
  });

  it('a second Success and a restart mid-way re-verify the same output, once', async () => {
    const first = fakeDeps();
    first.bridge.fetchKoiosTx.mockResolvedValue(undefined); // Koios lags
    const d = await sent();
    await pollDeposits(first);
    await pollDeposits(first); // second Success, same redeemHash
    expect(await row(d.id)).toMatchObject({
      state: 'bridge_processing',
      redeemTxHash: REDEEM,
    });

    const restarted = fakeDeps(); // a new process: only the DB carries over
    restarted.fundsUtxo.mockRejectedValue(new Error('L1 down'));
    await pollDeposits(restarted);
    expect((await row(d.id)).state).toBe('l1_confirmed');
    await pollDeposits(restarted);
    expect(restarted.bridge.getStatus).toHaveBeenCalledOnce(); // l1_confirmed leaves the bridge leg

    const changed = await sent({
      btcVout: 7,
      state: 'bridge_processing',
      redeemTxHash: hex32(),
    });
    await pollDeposits(restarted);
    expect(await row(changed.id)).toMatchObject({
      state: 'needs_attention',
      error: 'REDEEM_HASH_CHANGED',
    });
  });

  it('Trusteeship needs attention but a later Success resumes it; Refund fails', async () => {
    const deps = fakeDeps();
    deps.fundsUtxo.mockRejectedValue(new Error('L1 down'));
    const d = await sent();
    deps.bridge.getStatus.mockImplementationOnce(
      status({ status: 'Trusteeship' })
    );
    await pollDeposits(deps);
    expect(await row(d.id)).toMatchObject({
      state: 'needs_attention',
      error: 'BRIDGE_TRUSTEESHIP',
    });
    await pollDeposits(deps); // Success arrives late
    expect(await row(d.id)).toMatchObject({
      state: 'l1_confirmed',
      redeemTxHash: REDEEM,
    });

    const r = await sent({ btcVout: 1 });
    deps.bridge.getStatus.mockImplementation(status({ status: 'Refund' }));
    await pollDeposits(deps);
    expect(await row(r.id)).toMatchObject({
      state: 'failed',
      error: 'BRIDGE_REFUND',
    });
  });

  it('Processing for more than 2 h needs attention', async () => {
    const deps = fakeDeps();
    deps.bridge.getStatus.mockImplementation(status({ status: 'Processing' }));
    const d = await sent({
      btcSentAt: new Date(Date.now() - BRIDGE_TIMEOUT_MS - 1000),
    });
    await pollDeposits(deps);
    expect(await row(d.id)).toMatchObject({
      state: 'needs_attention',
      error: 'BRIDGE_TIMEOUT',
    });
  });

  it.each([
    [
      'METADATA_MISMATCH',
      {
        ...koiosTx,
        metadata: { 1: { uniqueId: '0x' + 'ab'.repeat(32), tokenPairID: 517 } },
      },
    ],
    ['NO_MATCHING_OUTPUT', { ...koiosTx, outputs: koiosTx.outputs.slice(1) }],
    [
      'QUANTITY_MISMATCH',
      {
        ...koiosTx,
        outputs: [
          {
            ...koiosTx.outputs[0],
            asset_list: [
              { ...koiosTx.outputs[0].asset_list![0], quantity: 199_679n },
            ],
          },
        ],
      },
    ],
  ])('L1 arrival %s needs attention and is not credited', async (error, tx) => {
    const deps = fakeDeps();
    deps.bridge.fetchKoiosTx.mockResolvedValue(tx);
    const d = await sent();
    await pollDeposits(deps);
    expect(await row(d.id)).toMatchObject({
      state: 'needs_attention',
      error,
      receivedBaseUnits: null,
    });
    expect(deps.submitCommit).not.toHaveBeenCalled();
  });

  it('an L1 output already credited to another deposit is never credited twice', async () => {
    const deps = fakeDeps();
    deps.fundsUtxo.mockRejectedValue(new Error('L1 down'));
    await confirmedOnL1(); // owns REDEEM#0
    const dup = await sent({
      btcVout: 1,
      state: 'bridge_processing',
      redeemTxHash: REDEEM,
    });
    await pollDeposits(deps);
    expect(await row(dup.id)).toMatchObject({
      state: 'needs_attention',
      error: 'L1_OUTPUT_ALREADY_CLAIMED',
      redeemIndex: null,
    });
  });
});

describe('poller: Hydra commit hand-off', () => {
  it('commits exactly the funds UTxO, persists depositTxId first, available on CommitFinalized', async () => {
    const deps = fakeDeps();
    const d = await confirmedOnL1();
    deps.submitCommit.mockImplementationOnce(async (funds, beforeSubmit) => {
      expect(funds).toBe(FUNDS);
      const id = hex32();
      await beforeSubmit(id);
      expect(await row(d.id)).toMatchObject({
        state: 'committing',
        depositTxId: id,
      });
      return id;
    });
    await pollDeposits(deps);
    const done = await row(d.id);
    expect(done).toMatchObject({
      state: 'available',
      fundsUnit: FUNDS_UNIT,
      fundsTxId: FUNDS.txHash,
      commitAttempts: 0,
    });
    expect(deps.fundsUtxo).toHaveBeenCalledWith(
      expect.objectContaining({ id: d.id })
    );
    expect(deps.awaitCommit).toHaveBeenCalledWith(
      done.depositTxId,
      COMMIT_WAIT_MS
    );
    expect(DepositSchema.parse(toDepositDto(done)).state).toBe('available');

    await pollDeposits(deps); // available is final: no second commit, no double credit
    expect(deps.submitCommit).toHaveBeenCalledOnce();
  });

  it('DepositExpired: recover, back to l1_confirmed, retried; needs attention after 3', async () => {
    const deps = fakeDeps();
    deps.awaitCommit.mockResolvedValue('expired');
    const d = await confirmedOnL1();
    await pollDeposits(deps);
    const first = await row(d.id);
    expect(first).toMatchObject({
      state: 'l1_confirmed',
      commitAttempts: 1,
      error: 'DEPOSIT_EXPIRED',
    });
    expect(deps.recover).toHaveBeenCalledWith(first.depositTxId);

    deps.awaitCommit.mockResolvedValueOnce('finalized');
    await pollDeposits(deps);
    expect(await row(d.id)).toMatchObject({
      state: 'available',
      commitAttempts: 1,
      error: null,
    });

    const e = await confirmedOnL1({ redeemIndex: 5, btcVout: 5 });
    for (let i = 0; i < 4; i++) await pollDeposits(deps);
    expect(await row(e.id)).toMatchObject({
      state: 'needs_attention',
      commitAttempts: 3,
    });
    expect(deps.submitCommit).toHaveBeenCalledTimes(2 + 3);
  });

  it('a failure before submitting keeps l1_confirmed without using an attempt', async () => {
    const deps = fakeDeps();
    deps.fundsUtxo.mockRejectedValueOnce(new Error('Blockfrost 503'));
    const d = await confirmedOnL1();
    await pollDeposits(deps);
    expect(await row(d.id)).toMatchObject({
      state: 'l1_confirmed',
      commitAttempts: 0,
      error: 'COMMIT_NOT_STARTED: Blockfrost 503',
    });
    await pollDeposits(deps);
    expect((await row(d.id)).state).toBe('available');
  });

  it('restart while committing: settled from the L2 snapshot, or retried after the deadline', async () => {
    const deps = fakeDeps(); // fresh process: no live CommitFinalized wait
    const committing = {
      state: 'committing',
      fundsUnit: FUNDS_UNIT,
      depositTxId: hex32(),
    };
    const young = await confirmedOnL1(committing);
    await pollDeposits(deps);
    expect((await row(young.id)).state).toBe('committing');

    deps.snapshot.mockResolvedValue([FUNDS]);
    await pollDeposits(deps);
    expect((await row(young.id)).state).toBe('available');

    deps.snapshot.mockResolvedValue([]);
    const old = await confirmedOnL1({
      ...committing,
      redeemIndex: 1,
      btcVout: 1,
      depositTxId: hex32(),
    });
    await prisma.deposit.update({
      where: { id: old.id },
      data: { updatedAt: new Date(Date.now() - COMMIT_WAIT_MS - 1000) },
    });
    deps.fundsUtxo.mockRejectedValue(new Error('not back on L1 yet'));
    await pollDeposits(deps);
    expect(await row(old.id)).toMatchObject({
      state: 'l1_confirmed',
      commitAttempts: 1,
      error: expect.stringMatching(/^COMMIT_NOT_STARTED/),
    });
    expect(deps.recover).toHaveBeenCalledWith(old.depositTxId);

    deps.snapshot.mockResolvedValue([FUNDS]); // that deposit had finalized after all
    await pollDeposits(deps);
    expect((await row(old.id)).state).toBe('available');
    expect(deps.submitCommit).not.toHaveBeenCalled();
  });

  it('waits for the payment mutex before submitting to Hydra', async () => {
    const deps = fakeDeps();
    await confirmedOnL1();
    let release!: () => void;
    const held = withLock(() => new Promise<void>((r) => (release = r)));
    const poll = pollDeposits(deps);
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.fundsUtxo).toHaveBeenCalled();
    expect(deps.submitCommit).not.toHaveBeenCalled();
    release();
    await Promise.all([held, poll]);
    expect(deps.submitCommit).toHaveBeenCalledOnce();
  });

  it('the poller is single-flight', async () => {
    let calls = 0;
    let release!: () => void;
    const tick = singleFlight(() => {
      calls++;
      return new Promise<void>((r) => (release = r));
    });
    const a = tick();
    const b = tick();
    expect(calls).toBe(1);
    release();
    await Promise.all([a, b]);
    void tick();
    expect(calls).toBe(2);
    release();
  });
});
