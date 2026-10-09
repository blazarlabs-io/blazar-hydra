import {
  Assets,
  getAddressDetails,
  LucidEvolution,
  UTxO,
} from '@lucid-evolution/lucid';
import { Payment as PaymentRow, Prisma } from '@prisma/client';
import _ from 'lodash';
import { env, prisma } from '../../config';
import { DBOps } from '../../prisma/db-ops';
import { logger } from '../../shared/logger';
import { DBStatus } from '../../shared/prisma-schemas';
import {
  ASSETS,
  AssetUnit,
  CreatePayment,
  NEXT_STATES,
  Payment,
  PaymentState,
  TERMINAL_STATES,
} from '../../shared/payment-contract';
import { fundsDatumOf, spendable } from '../lib/funds';
import {
  fetchSnapshot,
  submitTxAndAwaitSnapshot,
  SubmitOutcome,
} from '../lib/hydra';
import { dataAddressToBech32 } from '../lib/utils';
import { payMerchant } from '../tx-builders/pay';

export const PAYMENT_TTL_MS = 120_000;
export const SUBMIT_WAIT_MS = 30_000;
export const RECONCILE_AFTER_MS = 60_000;
const BOOTSTRAP_LOVELACE = 2_000_000n; // a new merchant funds UTxO must be created with >= 2 ADA

type PaymentError = NonNullable<Payment['error']>;
type PayTx = {
  payer: UTxO;
  merchantUtxo?: UTxO;
  merchantAddress: string;
  assets: Assets;
  snapshot: UTxO[];
};

/** Everything that touches Hydra or keys, injectable so tests need no live node. */
export type PaymentDeps = {
  lucid: LucidEvolution; // network for datum address decoding; signing in the default `build`
  snapshot: () => Promise<UTxO[]>;
  build: (tx: PayTx) => Promise<{ cborHex: string; txId: string }>;
  submit: (
    cborHex: string,
    txId: string,
    timeoutMs: number
  ) => Promise<SubmitOutcome>;
};

export const paymentDeps = (lucid: LucidEvolution): PaymentDeps => ({
  lucid,
  snapshot: () => fetchSnapshot(env.ADMIN_NODE_API_URL),
  build: (tx) => buildSignedPayTx(lucid, tx),
  submit: (cborHex, txId, timeoutMs) =>
    submitTxAndAwaitSnapshot(env.ADMIN_NODE_WS_URL, cborHex, txId, timeoutMs),
});

// ponytail: one process-wide lock around UTxO selection + submit + reconcile; per-payer locks if throughput matters.
let lockTail: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => undefined);
  return run;
}

/** Compare-and-set on `state`: the only way a payment changes state. True when this call won. */
async function cas(
  id: string,
  from: PaymentState,
  to: PaymentState,
  data: Prisma.PaymentUpdateManyMutationInput = {},
  where: Prisma.PaymentWhereInput = {}
): Promise<boolean> {
  if (!NEXT_STATES[from].includes(to)) {
    throw new Error(`Illegal payment transition ${from} -> ${to}`);
  }
  const { count } = await prisma.payment.updateMany({
    where: { ...where, id, state: from },
    data: { ...data, state: to },
  });
  return count === 1;
}

export function toPaymentDto(p: PaymentRow): Payment {
  return {
    paymentId: p.id,
    merchantAddress: p.merchantAddress,
    assetUnit: p.assetUnit as AssetUnit,
    decimals: ASSETS[p.assetUnit as AssetUnit].decimals,
    amountBaseUnits: p.amountBaseUnits,
    state: p.state as PaymentState,
    expiresAt: p.expiresAt.toISOString(),
    payerAddress: p.payerAddress,
    fundsInRef: p.fundsInRef,
    hydraTxId: p.hydraTxId,
    snapshotNumber: p.snapshotNumber,
    error: p.error as Payment['error'],
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export const createPayment = (c: CreatePayment) =>
  prisma.payment.create({
    data: { ...c, expiresAt: new Date(Date.now() + PAYMENT_TTL_MS) },
  });

/** Oldest unexpired `created` payment of a merchant (terminal polling). */
export const pendingPaymentFor = (merchantAddress: string) =>
  prisma.payment.findFirst({
    where: { merchantAddress, state: 'created', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
  });

/** Read with lazy expiry, and lazy reconcile of a `submitted` payment older than RECONCILE_AFTER_MS. */
export async function readPayment(
  id: string,
  deps: PaymentDeps
): Promise<PaymentRow | null> {
  const p = await prisma.payment.findUnique({ where: { id } });
  if (p?.state === 'created' && p.expiresAt <= new Date()) {
    await cas(id, 'created', 'expired', { error: 'EXPIRED' });
  } else if (
    p?.state === 'submitted' &&
    Date.now() - p.updatedAt.getTime() > RECONCILE_AFTER_MS
  ) {
    await withLock(() => reconcileOne(id, deps)).catch((e) =>
      logger.warning(`reconcile ${id} postponed: ${e}`)
    );
  } else {
    return p;
  }
  return prisma.payment.findUnique({ where: { id } });
}

/**
 * POST /payments/:id/authorize. Exactly one caller wins created -> authorized and runs the executor;
 * a repeat by the same payer is a no-op 200, another payer gets 409, an expired payment 410.
 */
export async function authorizePayment(
  id: string,
  payerAddress: string,
  deps: PaymentDeps
): Promise<{ status: number; payment: PaymentRow | null }> {
  const won = await cas(
    id,
    'created',
    'authorized',
    { payerAddress },
    { expiresAt: { gt: new Date() } }
  );
  if (won) {
    await withLock(() => executePayment(id, deps));
    const p = await prisma.payment.findUniqueOrThrow({ where: { id } });
    const final = TERMINAL_STATES.includes(p.state as PaymentState);
    return { status: final ? 200 : 202, payment: p };
  }
  const p = await readPayment(id, deps);
  if (!p) return { status: 404, payment: null };
  if (p.state === 'expired') return { status: 410, payment: p };
  if (p.payerAddress === payerAddress) return { status: 200, payment: p };
  return { status: 409, payment: p };
}

/** Payer funds UTxO in L2: User datum for `payerAddress` with enough spendable `unit`. */
export function selectPayerUtxo(
  lucid: LucidEvolution,
  snapshot: UTxO[],
  payerAddress: string,
  unit: string,
  amount: bigint
): { utxo: UTxO } | { error: 'NO_L2_FUNDS' | 'INSUFFICIENT_FUNDS' } {
  const mine = snapshot.flatMap((u) => {
    const d = fundsDatumOf(u);
    return d &&
      d.funds_type !== 'Merchant' &&
      dataAddressToBech32(lucid, d.addr) === payerAddress
      ? [{ u, d }]
      : [];
  });
  if (mine.length === 0) return { error: 'NO_L2_FUNDS' };
  const hit = mine.find(({ u, d }) => spendable(u, d, unit) >= amount);
  return hit ? { utxo: hit.u } : { error: 'INSUFFICIENT_FUNDS' };
}

export function findMerchantUtxo(
  lucid: LucidEvolution,
  snapshot: UTxO[],
  merchantAddress: string
): UTxO | undefined {
  return snapshot.find((u) => {
    const d = fundsDatumOf(u);
    return (
      d?.funds_type === 'Merchant' &&
      dataAddressToBech32(lucid, d.addr) === merchantAddress
    );
  });
}

/** authorized -> submitted -> confirmed | failed. Must run under withLock. */
export async function executePayment(
  id: string,
  deps: PaymentDeps
): Promise<void> {
  const p = await prisma.payment.findUnique({ where: { id } });
  if (!p || p.state !== 'authorized' || !p.payerAddress) return;
  const fail = async (error: PaymentError) => {
    logger.info(`payment ${id} failed: ${error}`);
    await cas(id, 'authorized', 'failed', { error });
  };

  let tx: { cborHex: string; txId: string };
  try {
    if ((await DBOps.getActiveHead())?.status !== DBStatus.RUNNING) {
      logger.error(`payment ${id}: no RUNNING head`);
      return fail('INTERNAL');
    }
    const snapshot = await deps.snapshot();
    const amount = BigInt(p.amountBaseUnits);
    const pick = selectPayerUtxo(
      deps.lucid,
      snapshot,
      p.payerAddress,
      p.assetUnit,
      amount
    );
    if ('error' in pick) return fail(pick.error);
    const merchantUtxo = findMerchantUtxo(
      deps.lucid,
      snapshot,
      p.merchantAddress
    );
    const bootstraps =
      p.assetUnit === 'lovelace' && amount >= BOOTSTRAP_LOVELACE;
    if (!merchantUtxo && !bootstraps) return fail('MERCHANT_NOT_BOOTSTRAPPED');
    // Exactly the requested amount of one unit; no hidden ADA (L2 fees are 0).
    tx = await deps.build({
      payer: pick.utxo,
      merchantUtxo,
      merchantAddress: p.merchantAddress,
      assets: { [p.assetUnit]: amount },
      snapshot,
    });
    // Persist hydraTxId before NewTx, so a crash after sending can still be reconciled. Throws on a
    // hydraTxId already recorded (an identical tx of an earlier payment that never landed).
    const fundsInRef = `${pick.utxo.txHash}#${pick.utxo.outputIndex}`;
    const data = { fundsInRef, hydraTxId: tx.txId };
    if (!(await cas(id, 'authorized', 'submitted', data))) return;
  } catch (e) {
    logger.error(`payment ${id}: ${e}`);
    return fail('INTERNAL');
  }

  const r = await deps.submit(tx.cborHex, tx.txId, SUBMIT_WAIT_MS);
  if (r.outcome === 'confirmed') {
    await cas(id, 'submitted', 'confirmed', {
      snapshotNumber: r.snapshotNumber,
    });
  } else if (r.outcome === 'invalid') {
    await cas(id, 'submitted', 'failed', { error: 'TX_INVALID' });
  } // 'pending': stays submitted; readPayment / boot reconcile settle it
}

/**
 * Outcome of a `submitted` payment from the head UTxO set. Sound because the executor is serialized
 * and only this backend spends user funds: if neither our outputs nor our input are there, our tx
 * spent the input and its outputs were spent later.
 */
export function reconcileDecision(
  snapshot: UTxO[],
  hydraTxId: string,
  fundsInRef: string
): 'confirmed' | 'NOT_SUBMITTED' {
  const refs = new Set(snapshot.map((u) => `${u.txHash}#${u.outputIndex}`));
  if (refs.has(`${hydraTxId}#0`) || refs.has(`${hydraTxId}#1`))
    return 'confirmed';
  return refs.has(fundsInRef) ? 'NOT_SUBMITTED' : 'confirmed';
}

async function settle(p: PaymentRow, snapshot: UTxO[]): Promise<void> {
  const d = reconcileDecision(snapshot, p.hydraTxId!, p.fundsInRef!);
  logger.info(`reconcile payment ${p.id}: ${d}`);
  if (d === 'confirmed') await cas(p.id, 'submitted', 'confirmed');
  else await cas(p.id, 'submitted', 'failed', { error: 'NOT_SUBMITTED' });
}

async function reconcileOne(id: string, deps: PaymentDeps): Promise<void> {
  const p = await prisma.payment.findUnique({ where: { id } });
  if (p?.state === 'submitted') await settle(p, await deps.snapshot());
}

/** Boot: nothing is executing yet. Settle old `submitted` payments; `authorized` never reached NewTx. */
export async function reconcileOnBoot(deps: PaymentDeps): Promise<void> {
  const stuck = await prisma.payment.updateMany({
    where: { state: 'authorized' },
    data: { state: 'failed', error: 'INTERNAL' },
  });
  const due = await prisma.payment.findMany({
    where: {
      state: 'submitted',
      updatedAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
    },
  });
  if (due.length > 0) {
    const snapshot = await deps.snapshot();
    for (const p of due) await settle(p, snapshot);
  }
  logger.info(
    `boot reconcile: ${stuck.count} authorized failed, ${due.length} submitted settled`
  );
}

async function buildSignedPayTx(
  lucid: LucidEvolution,
  t: PayTx
): Promise<{ cborHex: string; txId: string }> {
  const local = _.cloneDeep(lucid);
  local.selectWallet.fromSeed(env.SEED);
  const adminAddress = await local.wallet().address();
  const adminKey = getAddressDetails(adminAddress).paymentCredential?.hash;
  const adminCollateral = t.snapshot.find((u) => u.address === adminAddress);
  if (!adminKey || !adminCollateral) {
    throw new Error('Admin key or admin collateral UTxO in L2 not found');
  }
  const { tx } = await payMerchant(local, {
    adminCollateral,
    adminKey,
    hydraKey: env.HYDRA_KEY,
    merchantAddress: t.merchantAddress,
    assets: t.assets,
    userFundsUtxo: t.payer,
    merchantFundsUtxo: t.merchantUtxo,
    // The 2x validator does not check it; consent is the authenticated authorize call.
    signature: '',
  });
  const signed = await local.fromTx(tx.toCBOR()).sign.withWallet().complete();
  return { cborHex: signed.toCBOR(), txId: signed.toHash() };
}
