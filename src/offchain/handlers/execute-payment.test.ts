import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  credentialToAddress,
  Data,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { randomBytes } from 'crypto';
import { prisma } from '../../config';
import { PaymentSchema } from '../../shared/payment-contract';
import { DBStatus } from '../../shared/prisma-schemas';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { bech32ToAddressType } from '../lib/utils';
import {
  authorizePayment,
  createPayment,
  PaymentDeps,
  pendingPaymentFor,
  readPayment,
  reconcileDecision,
  reconcileOnBoot,
  selectPayerUtxo,
  toPaymentDto,
} from './execute-payment';

// Only lucid.config().network is used outside the default (real) tx builder.
const lucid = {
  config: () => ({ network: 'Preprod' }),
} as unknown as LucidEvolution;
const USDM = '77484e67c1ed6c96f55b89206cb5d6caae9a09a0bd473bba817929fe5553444d';
const CONTROL = `${'cc'.repeat(28)}${'01'.repeat(32)}`; // validation token, never payable
const SCRIPT = credentialToAddress('Preprod', {
  type: 'Script',
  hash: 'ee'.repeat(28),
});
const addr = (b: string) =>
  credentialToAddress(
    'Preprod',
    { type: 'Key', hash: b.repeat(28) },
    { type: 'Key', hash: '0f'.repeat(28) }
  );
const PAYER = addr('a1');
const OTHER_PAYER = addr('a2');
let seq = 0;
const nextMerchant = () => addr(`b${(++seq).toString(16)}`); // b1, b2, ... (< 16 merchants)

const datum = (owner: string, kind: 'user' | 'merchant') =>
  Data.to<FundsDatumT>(
    {
      addr: bech32ToAddressType(lucid, owner),
      locked_deposit: kind === 'user' ? 2_000_000n : 0n,
      funds_type:
        kind === 'user'
          ? { User: { public_key: '00'.repeat(32) } }
          : 'Merchant',
    },
    FundsDatum
  );
const utxo = (
  txHash: string,
  outputIndex: number,
  assets: UTxO['assets'],
  d?: string
): UTxO => ({
  txHash,
  outputIndex,
  address: SCRIPT,
  assets,
  datum: d ?? null,
});
const userFunds = (
  assets: UTxO['assets'],
  owner = PAYER,
  tx = '11'.repeat(32)
) => utxo(tx, 0, { [CONTROL]: 1n, ...assets }, datum(owner, 'user'));
const merchantFunds = (owner: string) =>
  utxo(
    '22'.repeat(32),
    0,
    { [CONTROL]: 1n, lovelace: 2_000_000n },
    datum(owner, 'merchant')
  );

function fakeDeps(
  snapshot: UTxO[],
  outcome: Awaited<ReturnType<PaymentDeps['submit']>> = {
    outcome: 'confirmed',
    snapshotNumber: 42,
  }
) {
  const txId = randomBytes(32).toString('hex'); // hydraTxId is unique in the DB
  return {
    txId,
    lucid,
    snapshot: vi.fn(async () => snapshot),
    build: vi.fn(async () => ({ cborHex: '84a0', txId })),
    submit: vi.fn(async () => outcome),
  } satisfies PaymentDeps & { txId: string };
}

const newPayment = (
  merchantAddress: string,
  assetUnit = 'lovelace',
  amountBaseUnits = '1000000'
) =>
  createPayment({
    merchantAddress,
    assetUnit: assetUnit as 'lovelace',
    amountBaseUnits,
  });

beforeAll(async () => {
  await prisma.process.create({ data: { status: DBStatus.RUNNING } });
});

describe('selectPayerUtxo (per-unit funds check)', () => {
  it('NO_L2_FUNDS when the payer has no user funds UTxO', () => {
    const snap = [
      userFunds({ lovelace: 10_000_000n }, OTHER_PAYER),
      merchantFunds(PAYER),
    ];
    expect(selectPayerUtxo(lucid, snap, PAYER, 'lovelace', 1n)).toEqual({
      error: 'NO_L2_FUNDS',
    });
  });

  it('lovelace keeps locked_deposit back, exactly at the boundary', () => {
    const snap = [userFunds({ lovelace: 5_000_000n })];
    expect(
      selectPayerUtxo(lucid, snap, PAYER, 'lovelace', 3_000_000n)
    ).toHaveProperty('utxo');
    expect(selectPayerUtxo(lucid, snap, PAYER, 'lovelace', 3_000_001n)).toEqual(
      { error: 'INSUFFICIENT_FUNDS' }
    );
  });

  it('checks the requested unit only and picks the UTxO that has it', () => {
    const poor = userFunds(
      { lovelace: 50_000_000n, [USDM]: 1n },
      PAYER,
      '33'.repeat(32)
    );
    const rich = userFunds(
      { lovelace: 2_000_000n, [USDM]: 10_000_000n },
      PAYER,
      '44'.repeat(32)
    );
    const pick = selectPayerUtxo(lucid, [poor, rich], PAYER, USDM, 10_000_000n);
    expect(pick).toEqual({ utxo: rich });
    expect(
      selectPayerUtxo(lucid, [poor, rich], PAYER, USDM, 10_000_001n)
    ).toEqual({ error: 'INSUFFICIENT_FUNDS' });
  });
});

describe('reconcileDecision', () => {
  const IN = `${'11'.repeat(32)}#0`;
  const TX_ID = 'ab'.repeat(32);
  it.each([
    [
      'our merchant output is in the snapshot',
      [utxo(TX_ID, 0, {})],
      'confirmed',
    ],
    ['our payer output is in the snapshot', [utxo(TX_ID, 1, {})], 'confirmed'],
    [
      'the input is still unspent',
      [utxo('11'.repeat(32), 0, {})],
      'NOT_SUBMITTED',
    ],
    [
      'input spent, outputs spent later',
      [utxo('99'.repeat(32), 0, {})],
      'confirmed',
    ],
  ])('%s', (_name, snap, expected) => {
    expect(reconcileDecision(snap as UTxO[], TX_ID, IN)).toBe(expected);
  });
});

describe('authorize + executor', () => {
  it('double authorize (double tap) sends exactly one NewTx and confirms on the correlated snapshot', async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps([
      userFunds({ lovelace: 10_000_000n }),
      merchantFunds(merchant),
    ]);
    const p = await newPayment(merchant);

    const results = await Promise.all([
      authorizePayment(p.id, PAYER, deps),
      authorizePayment(p.id, PAYER, deps),
      authorizePayment(p.id, PAYER, deps),
    ]);
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);

    const again = await authorizePayment(p.id, PAYER, deps);
    expect(again.status).toBe(200);
    expect(deps.submit).toHaveBeenCalledOnce();

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row).toMatchObject({
      state: 'confirmed',
      hydraTxId: deps.txId,
      snapshotNumber: 42,
      payerAddress: PAYER,
    });
    expect(PaymentSchema.parse(toPaymentDto(row)).state).toBe('confirmed');

    expect((await authorizePayment(p.id, OTHER_PAYER, deps)).status).toBe(409);
  });

  it('two payers racing: exactly one wins, the other gets 409', async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps([
      userFunds({ lovelace: 10_000_000n }),
      userFunds({ lovelace: 10_000_000n }, OTHER_PAYER, '55'.repeat(32)),
      merchantFunds(merchant),
    ]);
    const p = await newPayment(merchant);
    const [a, b] = await Promise.all([
      authorizePayment(p.id, PAYER, deps),
      authorizePayment(p.id, OTHER_PAYER, deps),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? PAYER : OTHER_PAYER;
    expect(
      await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })
    ).toMatchObject({ payerAddress: winner, state: 'confirmed' });
    expect(deps.submit).toHaveBeenCalledOnce();
  });

  it('pays exactly the requested amount and persists hydraTxId before NewTx', async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps([
      userFunds({ lovelace: 3_000_000n, [USDM]: 5_000_000n }),
      merchantFunds(merchant),
    ]);
    const p = await newPayment(merchant, USDM, '5000000');
    deps.submit.mockImplementationOnce(async () => {
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(row).toMatchObject({
        state: 'submitted',
        hydraTxId: deps.txId,
        fundsInRef: `${'11'.repeat(32)}#0`,
      });
      return { outcome: 'confirmed', snapshotNumber: 7 };
    });
    expect((await authorizePayment(p.id, PAYER, deps)).status).toBe(200);
    expect(deps.build).toHaveBeenCalledWith(
      expect.objectContaining({ assets: { [USDM]: 5_000_000n } })
    );
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: p.id } }))
        .snapshotNumber
    ).toBe(7);
  });

  it('insufficient funds fails without building or sending', async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps([
      userFunds({ lovelace: 2_500_000n }),
      merchantFunds(merchant),
    ]);
    const p = await newPayment(merchant, 'lovelace', '600000');
    const r = await authorizePayment(p.id, PAYER, deps);
    expect(r.status).toBe(200);
    expect(r.payment).toMatchObject({
      state: 'failed',
      error: 'INSUFFICIENT_FUNDS',
      hydraTxId: null,
    });
    expect(deps.build).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('MERCHANT_NOT_BOOTSTRAPPED unless the first payment is >= 2 ADA', async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps([userFunds({ lovelace: 20_000_000n, [USDM]: 9n })]);
    const usdm = await newPayment(merchant, USDM, '9');
    expect(
      (await authorizePayment(usdm.id, PAYER, deps)).payment
    ).toMatchObject({
      state: 'failed',
      error: 'MERCHANT_NOT_BOOTSTRAPPED',
    });
    const small = await newPayment(merchant, 'lovelace', '1999999');
    expect((await authorizePayment(small.id, PAYER, deps)).payment?.error).toBe(
      'MERCHANT_NOT_BOOTSTRAPPED'
    );
    const bootstrap = await newPayment(merchant, 'lovelace', '2000000');
    expect(
      (await authorizePayment(bootstrap.id, PAYER, deps)).payment?.state
    ).toBe('confirmed');
    expect(deps.build).toHaveBeenCalledWith(
      expect.objectContaining({ merchantUtxo: undefined })
    );
  });

  it('an identical tx already recorded by another payment fails cleanly, not stuck authorized', async () => {
    const merchant = nextMerchant();
    // The in-flight first payment would lock its input; age it so the executor settles it first.
    const deps = fakeDeps(
      [
        userFunds({ lovelace: 10_000_000n }, PAYER, 'e1'.repeat(32)),
        merchantFunds(merchant),
      ],
      { outcome: 'pending' }
    );
    const first = await newPayment(merchant);
    expect((await authorizePayment(first.id, PAYER, deps)).status).toBe(202);
    await prisma.payment.update({
      where: { id: first.id },
      data: { state: 'failed', error: 'NOT_SUBMITTED' },
    });
    const second = await newPayment(merchant); // same input, merchant, amount -> same tx id
    const r = await authorizePayment(second.id, PAYER, deps);
    expect(r.payment).toMatchObject({
      state: 'failed',
      error: 'INTERNAL',
      hydraTxId: null,
    });
    expect(deps.submit).toHaveBeenCalledOnce();
  });

  it('a later payment never spends the input of an unsettled one, so reconcile cannot confirm a tx that never landed', async () => {
    const merchant = nextMerchant();
    const funds = userFunds({ lovelace: 10_000_000n }, PAYER, 'e2'.repeat(32));
    // A: NewTx never reached the head (WS down), so A stays submitted with fundsInRef = funds.
    const depsA = fakeDeps([funds, merchantFunds(merchant)], {
      outcome: 'pending',
    });
    const a = await newPayment(merchant);
    expect((await authorizePayment(a.id, PAYER, depsA)).status).toBe(202);

    // B: the payer retries on a new request within 60 s.
    const depsB = fakeDeps([funds, merchantFunds(merchant)]);
    const b = await newPayment(merchant, 'lovelace', '2000000');
    const rb = await authorizePayment(b.id, PAYER, depsB);
    expect(rb.payment).toMatchObject({
      state: 'failed',
      error: 'INSUFFICIENT_FUNDS',
    });
    expect(depsB.build).not.toHaveBeenCalled();

    // A is reconciled later against whatever the head holds now.
    await prisma.payment.update({
      where: { id: a.id },
      data: { updatedAt: new Date(Date.now() - 61_000) },
    });
    const headNow = depsB.build.mock.calls.length
      ? [utxo(depsB.txId, 0, {}), utxo(depsB.txId, 1, {})] // B spent A's input
      : [funds, merchantFunds(merchant)];
    depsA.snapshot.mockResolvedValueOnce(headNow);
    expect(await readPayment(a.id, depsA)).toMatchObject({
      state: 'failed',
      error: 'NOT_SUBMITTED',
    });
  });

  it('settles a stale in-flight payment of the payer before selecting funds', async () => {
    const merchant = nextMerchant();
    const funds = userFunds({ lovelace: 10_000_000n }, PAYER, 'e3'.repeat(32));
    const depsA = fakeDeps([funds, merchantFunds(merchant)], {
      outcome: 'pending',
    });
    const a = await newPayment(merchant);
    expect((await authorizePayment(a.id, PAYER, depsA)).status).toBe(202);
    await prisma.payment.update({
      where: { id: a.id },
      data: { updatedAt: new Date(Date.now() - 61_000) },
    });

    const depsB = fakeDeps([funds, merchantFunds(merchant)]);
    const b = await newPayment(merchant, 'lovelace', '2000000');
    expect((await authorizePayment(b.id, PAYER, depsB)).payment?.state).toBe(
      'confirmed'
    );
    // A's input was still unspent when B was built: A never landed.
    expect(
      await prisma.payment.findUniqueOrThrow({ where: { id: a.id } })
    ).toMatchObject({ state: 'failed', error: 'NOT_SUBMITTED' });
  });

  it('TxInvalid for our tx fails the payment', async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps(
      [userFunds({ lovelace: 10_000_000n }), merchantFunds(merchant)],
      { outcome: 'invalid' }
    );
    const p = await newPayment(merchant);
    const r = await authorizePayment(p.id, PAYER, deps);
    expect(r.status).toBe(200);
    expect(r.payment).toMatchObject({
      state: 'failed',
      error: 'TX_INVALID',
      hydraTxId: deps.txId,
    });
  });

  it('no SnapshotConfirmed in time: 202 submitted, then reconciled lazily after 60 s', async () => {
    const merchant = nextMerchant();
    const funds = userFunds({ lovelace: 10_000_000n });
    const deps = fakeDeps([funds, merchantFunds(merchant)], {
      outcome: 'pending',
    });
    const p = await newPayment(merchant);
    const r = await authorizePayment(p.id, PAYER, deps);
    expect(r.status).toBe(202);
    expect(r.payment?.state).toBe('submitted');

    deps.snapshot.mockClear();
    expect((await readPayment(p.id, deps))?.state).toBe('submitted'); // too young to reconcile
    expect(deps.snapshot).not.toHaveBeenCalled();

    await prisma.payment.update({
      where: { id: p.id },
      data: { updatedAt: new Date(Date.now() - 61_000) },
    });
    deps.snapshot.mockResolvedValueOnce([
      utxo(deps.txId, 1, {}),
      merchantFunds(merchant),
    ]);
    expect(await readPayment(p.id, deps)).toMatchObject({
      state: 'confirmed',
      snapshotNumber: null,
    });
  });
});

describe('expiry', () => {
  it('an expired request cannot be authorized (410) and is no longer pending', async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps([
      userFunds({ lovelace: 10_000_000n }),
      merchantFunds(merchant),
    ]);
    const p = await newPayment(merchant);
    expect((await pendingPaymentFor(merchant))?.id).toBe(p.id);

    await prisma.payment.update({
      where: { id: p.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(await pendingPaymentFor(merchant)).toBeNull();
    const r = await authorizePayment(p.id, PAYER, deps);
    expect(r.status).toBe(410);
    expect(r.payment).toMatchObject({
      state: 'expired',
      error: 'EXPIRED',
      payerAddress: null,
    });
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it("a new request supersedes the merchant's older unpaid one, so the terminal never serves a stale amount", async () => {
    const merchant = nextMerchant();
    const deps = fakeDeps([
      userFunds({ lovelace: 30_000_000n }, PAYER, 'e4'.repeat(32)),
      merchantFunds(merchant),
    ]);
    const typo = await newPayment(merchant, 'lovelace', '10000000');
    const real = await newPayment(merchant, 'lovelace', '25000000');
    expect((await pendingPaymentFor(merchant))?.id).toBe(real.id);
    const r = await authorizePayment(typo.id, PAYER, deps);
    expect(r.status).toBe(410);
    expect(r.payment).toMatchObject({ state: 'expired', error: 'EXPIRED' });
    expect(deps.build).not.toHaveBeenCalled();
    // Other merchants' requests are untouched.
    const other = await newPayment(nextMerchant());
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { id: real.id } })).state
    ).toBe('created');
    expect(other.state).toBe('created');
  });

  it('a read after expiresAt marks it expired', async () => {
    const p = await newPayment(nextMerchant());
    await prisma.payment.update({
      where: { id: p.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect((await readPayment(p.id, fakeDeps([])))?.state).toBe('expired');
  });

  it('unknown id is 404', async () => {
    expect(
      (
        await authorizePayment(
          '00000000-0000-4000-8000-000000000000',
          PAYER,
          fakeDeps([])
        )
      ).status
    ).toBe(404);
  });
});

describe('reconcileOnBoot', () => {
  it('fails unsent authorized payments and settles old submitted ones from the snapshot', async () => {
    const m = nextMerchant();
    const old = new Date(Date.now() - 120_000);
    const authorized = await prisma.payment.create({
      data: {
        merchantAddress: m,
        assetUnit: 'lovelace',
        amountBaseUnits: '1',
        expiresAt: old,
        state: 'authorized',
        payerAddress: PAYER,
      },
    });
    const sub = (txId: string, fundsInRef: string, updatedAt: Date) =>
      prisma.payment.create({
        data: {
          merchantAddress: m,
          assetUnit: 'lovelace',
          amountBaseUnits: '1',
          expiresAt: old,
          state: 'submitted',
          payerAddress: PAYER,
          hydraTxId: txId,
          fundsInRef,
          updatedAt,
        },
      });
    const unsent = await sub('c1'.repeat(32), `${'d1'.repeat(32)}#0`, old);
    const landed = await sub('c2'.repeat(32), `${'d2'.repeat(32)}#0`, old);
    const young = await sub(
      'c3'.repeat(32),
      `${'d3'.repeat(32)}#0`,
      new Date()
    );

    await reconcileOnBoot(
      fakeDeps([utxo('d1'.repeat(32), 0, {}), utxo('c2'.repeat(32), 0, {})])
    );

    const state = async (id: string) =>
      prisma.payment.findUniqueOrThrow({ where: { id } });
    expect(await state(authorized.id)).toMatchObject({
      state: 'failed',
      error: 'INTERNAL',
    });
    expect(await state(unsent.id)).toMatchObject({
      state: 'failed',
      error: 'NOT_SUBMITTED',
    });
    expect(await state(landed.id)).toMatchObject({ state: 'confirmed' });
    expect(await state(young.id)).toMatchObject({ state: 'submitted' });
  });
});
