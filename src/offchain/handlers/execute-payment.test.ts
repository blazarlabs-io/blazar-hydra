import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CML,
  credentialToAddress,
  Data,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { Payment as PaymentRow } from '@prisma/client';
import { randomBytes } from 'crypto';
import { prisma } from '../../config';
import { PaymentSchema } from '../../shared/payment-contract';
import { DBStatus } from '../../shared/prisma-schemas';
import { FundsDatum, FundsDatumT } from '../lib/types';
import { bech32ToAddressType } from '../lib/utils';
import { payInfoCbor } from '../lib/pay-message';
import {
  authorizePayment,
  createPayment,
  PayConsent,
  PaymentDeps,
  pendingPaymentFor,
  readPayment,
  reconcileDecision,
  reconcileOnBoot,
  selectPayerUtxo,
  signPayload,
  toPaymentDto,
} from './execute-payment';

// Only lucid.config().network is used outside the default (real) tx builder.
const lucid = {
  config: () => ({ network: 'Preprod' }),
} as unknown as LucidEvolution;
// Payer phones (ed25519 seeds 01×32 and 02×32, the golden-vector keys of pay-message.test.ts).
const PAYER_KEY = CML.PrivateKey.from_normal_bytes(Buffer.from('01'.repeat(32), 'hex'));
const OTHER_KEY = CML.PrivateKey.from_normal_bytes(Buffer.from('02'.repeat(32), 'hex'));
const pkOf = (k: CML.PrivateKey) => Buffer.from(k.to_public().to_raw_bytes()).toString('hex');
const PAYER_PK = pkOf(PAYER_KEY);
const OTHER_PK = pkOf(OTHER_KEY);
const USDM = 'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d';
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
const nextMerchant = () => addr((0xb0 + ++seq).toString(16)); // b1, b2, ... ff (< 80 merchants)

// User funds are locked under the owner's phone key (PAYER -> seed 01, OTHER_PAYER -> seed 02) unless given.
const datum = (owner: string, kind: 'user' | 'merchant', key = owner === OTHER_PAYER ? OTHER_PK : PAYER_PK) =>
  Data.to<FundsDatumT>(
    {
      addr: bech32ToAddressType(lucid, owner),
      locked_deposit: kind === 'user' ? 2_000_000n : 0n,
      funds_type: kind === 'user' ? { User: { public_key: key } } : 'Merchant',
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
  tx = '11'.repeat(32),
  key?: string
) => utxo(tx, 0, { [CONTROL]: 1n, ...assets }, datum(owner, 'user', key));
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

/** What the phone sends: its signature over PayInfo(payment, funds UTxO) and its public key. */
const consent = (p: PaymentRow, funds: UTxO, key = PAYER_KEY): PayConsent => {
  const fundsInRef = `${funds.txHash}#${funds.outputIndex}`;
  const message = payInfoCbor({ ...p, fundsInRef });
  return { fundsInRef, publicKey: pkOf(key), signature: key.sign(Buffer.from(message, 'hex')).to_hex() };
};

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
    expect(selectPayerUtxo(lucid, snap, PAYER, PAYER_PK, 'lovelace', 1n)).toEqual({
      error: 'NO_L2_FUNDS',
    });
  });

  it('lovelace keeps locked_deposit back, exactly at the boundary', () => {
    const snap = [userFunds({ lovelace: 5_000_000n })];
    expect(
      selectPayerUtxo(lucid, snap, PAYER, PAYER_PK, 'lovelace', 3_000_000n)
    ).toHaveProperty('utxo');
    expect(selectPayerUtxo(lucid, snap, PAYER, PAYER_PK, 'lovelace', 3_000_001n)).toEqual(
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
    const pick = selectPayerUtxo(lucid, [poor, rich], PAYER, PAYER_PK, USDM, 10_000_000n);
    expect(pick).toEqual({ utxo: rich });
    expect(
      selectPayerUtxo(lucid, [poor, rich], PAYER, PAYER_PK, USDM, 10_000_001n)
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
    const funds = userFunds({ lovelace: 10_000_000n });
    const deps = fakeDeps([funds, merchantFunds(merchant)]);
    const p = await newPayment(merchant);

    const results = await Promise.all([
      authorizePayment(p.id, PAYER, deps, consent(p, funds)),
      authorizePayment(p.id, PAYER, deps, consent(p, funds)),
      authorizePayment(p.id, PAYER, deps, consent(p, funds)),
    ]);
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);

    const again = await authorizePayment(p.id, PAYER, deps, consent(p, funds));
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

    expect((await authorizePayment(p.id, OTHER_PAYER, deps, consent(p, funds, OTHER_KEY))).status).toBe(409);
  });

  it('two payers racing: exactly one wins, the other gets 409', async () => {
    const merchant = nextMerchant();
    const mine = userFunds({ lovelace: 10_000_000n });
    const theirs = userFunds({ lovelace: 10_000_000n }, OTHER_PAYER, '55'.repeat(32));
    const deps = fakeDeps([mine, theirs, merchantFunds(merchant)]);
    const p = await newPayment(merchant);
    const [a, b] = await Promise.all([
      authorizePayment(p.id, PAYER, deps, consent(p, mine)),
      authorizePayment(p.id, OTHER_PAYER, deps, consent(p, theirs, OTHER_KEY)),
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
    const funds = userFunds({ lovelace: 3_000_000n, [USDM]: 5_000_000n });
    const deps = fakeDeps([funds, merchantFunds(merchant)]);
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
    expect((await authorizePayment(p.id, PAYER, deps, consent(p, funds))).status).toBe(200);
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
    const funds = userFunds({ lovelace: 2_500_000n });
    const deps = fakeDeps([funds, merchantFunds(merchant)]);
    const p = await newPayment(merchant, 'lovelace', '600000');
    const r = await authorizePayment(p.id, PAYER, deps, consent(p, funds));
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
    const funds = userFunds({ lovelace: 20_000_000n, [USDM]: 9n });
    const deps = fakeDeps([funds]);
    const usdm = await newPayment(merchant, USDM, '9');
    expect(
      (await authorizePayment(usdm.id, PAYER, deps, consent(usdm, funds))).payment
    ).toMatchObject({
      state: 'failed',
      error: 'MERCHANT_NOT_BOOTSTRAPPED',
    });
    const small = await newPayment(merchant, 'lovelace', '1999999');
    expect((await authorizePayment(small.id, PAYER, deps, consent(small, funds))).payment?.error).toBe(
      'MERCHANT_NOT_BOOTSTRAPPED'
    );
    const bootstrap = await newPayment(merchant, 'lovelace', '2000000');
    expect(
      (await authorizePayment(bootstrap.id, PAYER, deps, consent(bootstrap, funds))).payment?.state
    ).toBe('confirmed');
    expect(deps.build).toHaveBeenCalledWith(
      expect.objectContaining({ merchantUtxo: undefined })
    );
  });

  it('an identical tx already recorded by another payment fails cleanly, not stuck authorized', async () => {
    const merchant = nextMerchant();
    // The in-flight first payment would lock its input; age it so the executor settles it first.
    const funds = userFunds({ lovelace: 10_000_000n }, PAYER, 'e1'.repeat(32));
    const deps = fakeDeps([funds, merchantFunds(merchant)], { outcome: 'pending' });
    const first = await newPayment(merchant);
    expect((await authorizePayment(first.id, PAYER, deps, consent(first, funds))).status).toBe(202);
    await prisma.payment.update({
      where: { id: first.id },
      data: { state: 'failed', error: 'NOT_SUBMITTED' },
    });
    const second = await newPayment(merchant); // same input, merchant, amount -> same tx id
    const r = await authorizePayment(second.id, PAYER, deps, consent(second, funds));
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
    expect((await authorizePayment(a.id, PAYER, depsA, consent(a, funds))).status).toBe(202);

    // B: the payer retries on a new request within 60 s, signing for the same, still locked, UTxO.
    const depsB = fakeDeps([funds, merchantFunds(merchant)]);
    const b = await newPayment(merchant, 'lovelace', '2000000');
    const rb = await authorizePayment(b.id, PAYER, depsB, consent(b, funds));
    expect(rb.payment).toMatchObject({
      state: 'failed',
      error: 'STALE_FUNDS',
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
    expect((await authorizePayment(a.id, PAYER, depsA, consent(a, funds))).status).toBe(202);
    await prisma.payment.update({
      where: { id: a.id },
      data: { updatedAt: new Date(Date.now() - 61_000) },
    });

    const depsB = fakeDeps([funds, merchantFunds(merchant)]);
    const b = await newPayment(merchant, 'lovelace', '2000000');
    expect((await authorizePayment(b.id, PAYER, depsB, consent(b, funds))).payment?.state).toBe(
      'confirmed'
    );
    // A's input was still unspent when B was built: A never landed.
    expect(
      await prisma.payment.findUniqueOrThrow({ where: { id: a.id } })
    ).toMatchObject({ state: 'failed', error: 'NOT_SUBMITTED' });
  });

  it('a bad signature is a 400 and changes nothing; the right one pays', async () => {
    const merchant = nextMerchant();
    const funds = userFunds({ lovelace: 10_000_000n }, PAYER, 'f1'.repeat(32));
    const deps = fakeDeps([funds, merchantFunds(merchant)]);
    const p = await newPayment(merchant);
    const forged = { ...consent(p, funds, OTHER_KEY), publicKey: pkOf(PAYER_KEY) };
    const bad = await authorizePayment(p.id, PAYER, deps, forged);
    expect(bad).toMatchObject({ status: 400, error: 'BAD_SIGNATURE' });
    for (const signature of ['', 'zz', '00'.repeat(64)]) {
      expect((await authorizePayment(p.id, PAYER, deps, { ...consent(p, funds), signature })).error).toBe('BAD_SIGNATURE');
    }
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).state).toBe('created');
    expect(deps.build).not.toHaveBeenCalled();

    const ok = consent(p, funds);
    expect((await authorizePayment(p.id, PAYER, deps, ok)).status).toBe(200);
    expect(deps.build).toHaveBeenCalledWith(expect.objectContaining({ payer: funds, signature: ok.signature }));
  });

  it('never substitutes another funds UTxO for the signed one', async () => {
    const merchant = nextMerchant();
    const signed = userFunds({ lovelace: 10_000_000n }, PAYER, 'f2'.repeat(32));
    const other = userFunds({ lovelace: 10_000_000n }, PAYER, 'f3'.repeat(32));
    const deps = fakeDeps([other, merchantFunds(merchant)]); // the signed UTxO is gone
    const p = await newPayment(merchant);
    const r = await authorizePayment(p.id, PAYER, deps, consent(p, signed));
    expect(r.payment).toMatchObject({ state: 'failed', error: 'STALE_FUNDS' });
    expect(deps.build).not.toHaveBeenCalled();
  });

  it('funds locked under another key are neither proposed nor spent (the validator would reject them)', async () => {
    const merchant = nextMerchant();
    const foreign = userFunds({ lovelace: 10_000_000n }, PAYER, 'f5'.repeat(32), OTHER_PK);
    const deps = fakeDeps([foreign, merchantFunds(merchant)]);
    const p = await newPayment(merchant);
    expect(await signPayload(p.id, PAYER, PAYER_PK, deps)).toEqual({ status: 409, error: 'NO_L2_FUNDS' });
    const r = await authorizePayment(p.id, PAYER, deps, consent(p, foreign));
    expect(r.payment).toMatchObject({ state: 'failed', error: 'NO_L2_FUNDS' });
    expect(deps.build).not.toHaveBeenCalled();
  });

  it('sign-payload names the free funds UTxO and the exact bytes to sign', async () => {
    const merchant = nextMerchant();
    const funds = userFunds({ lovelace: 10_000_000n }, PAYER, 'f4'.repeat(32));
    const deps = fakeDeps([funds, merchantFunds(merchant)]);
    const p = await newPayment(merchant);
    const r = await signPayload(p.id, PAYER, PAYER_PK, deps);
    const fundsInRef = `${'f4'.repeat(32)}#0`;
    expect(r).toEqual({ status: 200, payload: { fundsInRef, payInfoCbor: payInfoCbor({ ...p, fundsInRef }) } });
    expect((await signPayload(p.id, OTHER_PAYER, OTHER_PK, deps)).error).toBe('NO_L2_FUNDS');
    await prisma.payment.update({ where: { id: p.id }, data: { expiresAt: new Date(Date.now() - 1) } });
    expect((await signPayload(p.id, PAYER, PAYER_PK, deps)).status).toBe(409);
    expect((await signPayload('00000000-0000-4000-8000-000000000000', PAYER, PAYER_PK, deps)).status).toBe(404);
  });

  it('TxInvalid for our tx fails the payment', async () => {
    const merchant = nextMerchant();
    const funds = userFunds({ lovelace: 10_000_000n });
    const deps = fakeDeps([funds, merchantFunds(merchant)], { outcome: 'invalid' });
    const p = await newPayment(merchant);
    const r = await authorizePayment(p.id, PAYER, deps, consent(p, funds));
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
    const r = await authorizePayment(p.id, PAYER, deps, consent(p, funds));
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
    const funds = userFunds({ lovelace: 10_000_000n });
    const deps = fakeDeps([funds, merchantFunds(merchant)]);
    const p = await newPayment(merchant);
    expect((await pendingPaymentFor(merchant))?.id).toBe(p.id);

    await prisma.payment.update({
      where: { id: p.id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(await pendingPaymentFor(merchant)).toBeNull();
    const r = await authorizePayment(p.id, PAYER, deps, consent(p, funds));
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
    const funds = userFunds({ lovelace: 30_000_000n }, PAYER, 'e4'.repeat(32));
    const deps = fakeDeps([funds, merchantFunds(merchant)]);
    const typo = await newPayment(merchant, 'lovelace', '10000000');
    const real = await newPayment(merchant, 'lovelace', '25000000');
    expect((await pendingPaymentFor(merchant))?.id).toBe(real.id);
    const r = await authorizePayment(typo.id, PAYER, deps, consent(typo, funds));
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
          fakeDeps([]),
          { fundsInRef: `${'11'.repeat(32)}#0`, signature: '', publicKey: pkOf(PAYER_KEY) }
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
