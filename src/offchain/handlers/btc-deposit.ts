/**
 * BTC deposits (M3 phase B): WanBridge testnet -> Cardano L1 -> Hydra -> payable L2 balance.
 *
 *   created -> btc_sent -> bridge_processing -> l1_confirmed -> committing -> available
 *   failed (bridge Refund), expired (no BTC tx before expiresAt), needs_attention (see `error`)
 *
 * Every state change is a compare-and-set on `state`; the unique keys (btcTxid, btcVout),
 * (redeemTxHash, redeemIndex) and depositTxId make "credit once" hold across retries and restarts.
 * Only the poller moves a deposit past btc_sent, and nothing is payable before `available`.
 */
import {
  LucidEvolution,
  Network,
  OutRef,
  selectUTxOs,
  toUnit,
  UTxO,
  walletFromSeed,
} from '@lucid-evolution/lucid';
import { Deposit as DepositRow, Prisma } from '@prisma/client';
import axios from 'axios';
import _ from 'lodash';
import * as wanbridge from '../../bridge/wanbridge';
import {
  assertDepositDestination,
  BTC_UNIT,
  findBtcDeposit,
  verifyCardanoArrival,
} from '../../bridge/wanbridge';
import { env, prisma } from '../../config';
import { DBOps } from '../../prisma/db-ops';
import { logger } from '../../shared/logger';
import { DBStatus } from '../../shared/prisma-schemas';
import {
  AssetUnit,
  Deposit,
  DepositState,
} from '../../shared/payment-contract';
import {
  awaitCommitFinalized,
  CommitOutcome,
  fetchSnapshot,
  submitCommit,
} from '../lib/hydra';
import { getNetworkFromLucid, getValidatorDetails } from '../lib/utils';
import { buildIncrementalCommitBlueprint } from '../tx-builders/commit-funds';
import { deposit, validationTokenName } from '../tx-builders/deposit';
import { withLock } from './execute-payment';

export const DEPOSIT_TTL_MS = 30 * 60_000; // decision 2
export const BRIDGE_TIMEOUT_MS = 2 * 60 * 60_000; // Processing beyond 2 h needs attention
// ponytail: sized for the head's --deposit-period 300s (deadline 2 x 300 s, plus L1 margin); raise with it.
export const COMMIT_WAIT_MS = 15 * 60_000;
export const MAX_COMMIT_ATTEMPTS = 3; // decision 5
/** needs_attention reasons the bridge can still resolve: a later Success resumes, Refund fails. */
const BRIDGE_RESUMABLE = ['BRIDGE_TIMEOUT', 'BRIDGE_TRUSTEESHIP'];
/** needs_attention reasons set when the BTC tx was attached: never credited automatically. */
const ATTACH_ERRORS = [
  'MEMO_MISSING',
  'MULTIPLE_OUTPUTS_TO_DEPOSIT_ADDRESS',
  'VALUE_MISMATCH',
];

/** Everything that touches the bridge, L1 or Hydra, injectable so tests need no network. */
export type DepositDeps = {
  bridge: Pick<
    typeof wanbridge,
    'getQuotaAndFee' | 'createTx2' | 'fetchBtcTx' | 'getStatus' | 'fetchKoiosTx'
  >;
  snapshot: () => Promise<UTxO[]>;
  /** L1: this deposit's user funds UTxO at the validator, created from the bridged UTxO if missing. */
  fundsUtxo: (d: DepositRow) => Promise<{ utxo: UTxO; unit: string }>;
  /** Hydra incremental commit of exactly `funds`; `beforeSubmit` gets the deposit tx id first. */
  submitCommit: (
    funds: UTxO,
    beforeSubmit: (depositTxId: string) => Promise<void>
  ) => Promise<string>;
  awaitCommit: (
    depositTxId: string,
    timeoutMs: number
  ) => Promise<CommitOutcome>;
  recover: (depositTxId: string) => Promise<void>;
};

const NEXT: Record<DepositState, readonly DepositState[]> = {
  created: ['btc_sent', 'needs_attention', 'expired'],
  expired: ['btc_sent', 'needs_attention'],
  btc_sent: ['bridge_processing', 'needs_attention', 'failed'],
  bridge_processing: ['l1_confirmed', 'needs_attention', 'failed'],
  needs_attention: ['bridge_processing', 'failed'],
  // -> available: an earlier commit whose wait timed out had in fact finalized
  l1_confirmed: ['committing', 'available'],
  committing: ['available', 'l1_confirmed', 'needs_attention'],
  available: [],
  failed: [],
};

/** Compare-and-set on `state` (same state = field update). True when this call won. */
async function cas(
  id: string,
  from: string,
  to: DepositState,
  data: Prisma.DepositUpdateManyMutationInput = {},
  where: Prisma.DepositWhereInput = {}
): Promise<boolean> {
  if (from !== to && !NEXT[from as DepositState].includes(to)) {
    throw new Error(`Illegal deposit transition ${from} -> ${to}`);
  }
  const { count } = await prisma.deposit.updateMany({
    where: { ...where, id, state: from },
    data: { ...data, state: to },
  });
  return count === 1;
}

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function toDepositDto(d: DepositRow): Deposit {
  return {
    depositId: d.id,
    userAddress: d.userAddress,
    assetUnit: d.assetUnit as AssetUnit,
    state: d.state as DepositState,
    requestedBaseUnits: d.requestedBaseUnits,
    receivedBaseUnits: d.receivedBaseUnits,
    btc: {
      toAccount: d.btcToAccount,
      valueSats: d.btcValueSats,
      memo: d.btcMemo,
    },
    expiresAt: d.expiresAt.toISOString(),
    btcTxid: d.btcTxid,
    btcVout: d.btcVout,
    l1Ref:
      d.redeemTxHash !== null && d.redeemIndex !== null
        ? `${d.redeemTxHash}#${d.redeemIndex}`
        : null,
    fundsTxId: d.fundsTxId,
    depositTxId: d.depositTxId,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ---------- API ----------

type User = { id: string; address: string };

/** POST /deposits/btc: createTx2 for DEPOSIT_ADDRESS, valid for 30 min. */
export async function createBtcDeposit(
  user: User,
  amountSats: bigint,
  deps: DepositDeps
): Promise<
  { status: 201; deposit: DepositRow } | { status: 422 | 502; error: string }
> {
  let btc: wanbridge.BtcDepositInstructions;
  try {
    const quota = await deps.bridge.getQuotaAndFee();
    if (amountSats < quota.minQuota || amountSats > quota.maxQuota) {
      return { status: 422, error: 'AMOUNT_OUT_OF_RANGE' };
    }
    btc = await deps.bridge.createTx2({
      fromAccount: env.BRIDGE_PLACEHOLDER_FROM,
      toAccount: env.DEPOSIT_ADDRESS,
      amountSats,
    });
  } catch (e) {
    logger.error(`createTx2 failed: ${message(e)}`);
    return { status: 502, error: 'BRIDGE_UNAVAILABLE' };
  }
  const deposit = await prisma.deposit.create({
    data: {
      userId: user.id,
      userAddress: user.address,
      assetUnit: BTC_UNIT,
      requestedBaseUnits: amountSats.toString(),
      btcToAccount: btc.depositAddress,
      btcValueSats: btc.valueSats.toString(),
      btcMemo: btc.memo,
      expiresAt: new Date(Date.now() + DEPOSIT_TTL_MS),
    },
  });
  return { status: 201, deposit };
}

/** The caller's deposit (null otherwise), marking `created` past expiresAt as expired. */
export async function readDeposit(
  id: string,
  userId: string
): Promise<DepositRow | null> {
  const d = await prisma.deposit.findUnique({ where: { id } });
  if (!d || d.userId !== userId) return null;
  if (d.state !== 'created' || d.expiresAt > new Date()) return d;
  await cas(id, 'created', 'expired', { error: 'EXPIRED' });
  return prisma.deposit.findUnique({ where: { id } });
}

type AttachResult =
  | { status: 200; deposit: DepositRow }
  | { status: 404 | 409 | 422; error: string; deposit?: DepositRow };

function attachOutcome(d: DepositRow, btcTxid: string): AttachResult {
  if (d.btcTxid !== btcTxid)
    return { status: 409, error: 'CONFLICT', deposit: d };
  if (d.state === 'needs_attention' && ATTACH_ERRORS.includes(d.error ?? '')) {
    return { status: 422, error: d.error!, deposit: d };
  }
  return { status: 200, deposit: d };
}

/**
 * POST /deposits/:id/btc-tx. The tx must pay exactly the saved toAccount and value, with the exact
 * memo. A tx that pays toAccount but fails a check is recorded as needs_attention (422), so the
 * bridge outcome stays traceable; it is never credited. Repeating the same txid is a no-op.
 */
export async function attachBtcTx(
  id: string,
  userId: string,
  btcTxid: string,
  deps: DepositDeps
): Promise<AttachResult> {
  const d = await readDeposit(id, userId);
  if (!d) return { status: 404, error: 'NOT_FOUND' };
  if (d.btcTxid !== null) return attachOutcome(d, btcTxid);

  const tx = await deps.bridge.fetchBtcTx(btcTxid).catch((e) => {
    logger.warning(`BTC tx ${btcTxid} not readable: ${message(e)}`);
    return undefined;
  });
  if (!tx) return { status: 422, error: 'BTC_TX_NOT_FOUND', deposit: d };
  const check = findBtcDeposit(tx, {
    depositAddress: d.btcToAccount,
    memo: d.btcMemo,
  });
  // Pays nothing to this deposit's BTC address (e.g. a typo): nothing in flight, nothing recorded.
  if (!check.ok && check.reason === 'NO_OUTPUT_TO_DEPOSIT_ADDRESS') {
    return { status: 422, error: check.reason, deposit: d };
  }
  const error = !check.ok
    ? check.reason
    : check.valueSats !== BigInt(d.btcValueSats)
      ? 'VALUE_MISMATCH'
      : null;
  try {
    await cas(
      id,
      d.state,
      error ? 'needs_attention' : 'btc_sent',
      {
        btcTxid,
        btcVout: check.ok ? check.vout : null,
        btcSentAt: new Date(),
        error,
      },
      { btcTxid: null }
    );
  } catch (e) {
    // (btcTxid, btcVout) is unique: the first deposit to claim a BTC output keeps it.
    if (isUniqueViolation(e)) {
      return { status: 409, error: 'BTC_TX_ALREADY_CLAIMED', deposit: d };
    }
    throw e;
  }
  return attachOutcome(
    await prisma.deposit.findUniqueOrThrow({ where: { id } }),
    btcTxid
  );
}

// ---------- poller ----------

/** Bridge leg: status by BTC txid, then the Cardano arrival on Koios. Never credits by itself. */
async function advanceBridge(d: DepositRow, deps: DepositDeps): Promise<void> {
  const s = await deps.bridge.getStatus(d.btcTxid!);
  if (s.status !== 'Success') {
    if (d.redeemTxHash !== null) return; // stale read after a recorded Success
    if (s.status === 'Refund') {
      await cas(d.id, d.state, 'failed', { error: 'BRIDGE_REFUND' });
    } else if (d.state === 'needs_attention') {
      return; // timed out or in Trusteeship: only Success or Refund move it on
    } else if (s.status === 'Trusteeship') {
      await cas(d.id, d.state, 'needs_attention', {
        error: 'BRIDGE_TRUSTEESHIP',
      });
    } else if (Date.now() - d.btcSentAt!.getTime() > BRIDGE_TIMEOUT_MS) {
      await cas(d.id, d.state, 'needs_attention', { error: 'BRIDGE_TIMEOUT' });
    } else if (s.status === 'Processing' && d.state === 'btc_sent') {
      await cas(d.id, 'btc_sent', 'bridge_processing');
    }
    return;
  }

  if (d.redeemTxHash !== null && d.redeemTxHash !== s.redeemHash) {
    await cas(d.id, d.state, 'needs_attention', {
      error: 'REDEEM_HASH_CHANGED',
    });
    return;
  }
  if (d.redeemTxHash === null) {
    const recorded = await cas(
      d.id,
      d.state,
      'bridge_processing',
      { redeemTxHash: s.redeemHash, error: null },
      { redeemTxHash: null }
    );
    if (!recorded) return;
  }
  const arrival = verifyCardanoArrival(
    await deps.bridge.fetchKoiosTx(s.redeemHash),
    {
      redeemHash: s.redeemHash,
      destination: env.DEPOSIT_ADDRESS,
      unit: BTC_UNIT,
      btcTxid: d.btcTxid!,
    }
  );
  if (!arrival.ok) {
    if (arrival.reason !== 'TX_NOT_FOUND') {
      await cas(d.id, 'bridge_processing', 'needs_attention', {
        error: arrival.reason,
      });
    } // TX_NOT_FOUND: not in a block on Koios yet, next tick
    return;
  }
  if (arrival.quantity !== s.receiveAmount) {
    await cas(d.id, 'bridge_processing', 'needs_attention', {
      error: 'QUANTITY_MISMATCH',
    });
    return;
  }
  try {
    await cas(d.id, 'bridge_processing', 'l1_confirmed', {
      redeemIndex: arrival.outRef.outputIndex,
      receivedBaseUnits: arrival.quantity.toString(),
    });
  } catch (e) {
    // (redeemTxHash, redeemIndex) is unique: another deposit already claimed this L1 output.
    if (!isUniqueViolation(e)) throw e;
    await cas(d.id, 'bridge_processing', 'needs_attention', {
      error: 'L1_OUTPUT_ALREADY_CLAIMED',
    });
  }
}

const inL2 = async (unit: string, deps: DepositDeps) =>
  (await deps.snapshot()).some((u) => (u.assets[unit] ?? 0n) > 0n);

/** committing -> l1_confirmed (or needs_attention after 3 attempts); recovers the Hydra deposit first. */
async function retryCommit(
  d: DepositRow,
  reason: string,
  deps: DepositDeps
): Promise<void> {
  if (d.depositTxId) {
    // Best effort: an expired Hydra deposit returns the funds UTxO to the validator on L1.
    await withLock(() => deps.recover(d.depositTxId!)).catch((e) =>
      logger.warning(`recover ${d.depositTxId}: ${message(e)}`)
    );
  }
  const attempts = d.commitAttempts + 1;
  const to =
    attempts >= MAX_COMMIT_ATTEMPTS ? 'needs_attention' : 'l1_confirmed';
  await cas(d.id, 'committing', to, {
    commitAttempts: attempts,
    error: reason,
  });
  logger.warning(
    `deposit ${d.id}: ${reason}, attempt ${attempts}/${MAX_COMMIT_ATTEMPTS} -> ${to}`
  );
}

/** l1_confirmed -> committing -> available: commit exactly this deposit's funds UTxO into the head. */
async function commitDeposit(d: DepositRow, deps: DepositDeps): Promise<void> {
  let depositTxId: string;
  try {
    if (d.fundsUnit && (await inL2(d.fundsUnit, deps))) {
      await cas(d.id, 'l1_confirmed', 'available', { error: null });
      return;
    }
    if ((await DBOps.getActiveHead())?.status !== DBStatus.RUNNING) {
      throw new Error('no RUNNING head');
    }
    const { utxo, unit } = await deps.fundsUtxo(d).catch(async (e) => {
      // An expired Hydra deposit still holds the funds UTxO: recover it for the next attempt.
      if (d.depositTxId) {
        await withLock(() => deps.recover(d.depositTxId!)).catch(
          () => undefined
        );
      }
      throw e;
    });
    await prisma.deposit.update({
      where: { id: d.id },
      data: { fundsUnit: unit, fundsTxId: d.fundsTxId ?? utxo.txHash },
    });
    depositTxId = await withLock(() =>
      deps.submitCommit(utxo, async (txId) => {
        // Persisted before the tx can land, so a restart resumes from `committing`.
        const won = await cas(d.id, 'l1_confirmed', 'committing', {
          depositTxId: txId,
          error: null,
        });
        if (!won) throw new Error('deposit changed concurrently');
      })
    );
  } catch (e) {
    const now = await prisma.deposit.findUniqueOrThrow({ where: { id: d.id } });
    if (now.state === 'committing') {
      return retryCommit(now, `COMMIT_FAILED: ${message(e)}`, deps);
    }
    // Nothing was submitted to Hydra: keep l1_confirmed and try again next tick.
    logger.error(`deposit ${d.id}: commit not started: ${message(e)}`);
    await cas(d.id, 'l1_confirmed', 'l1_confirmed', {
      error: `COMMIT_NOT_STARTED: ${message(e)}`,
    });
    return;
  }

  logger.info(
    `deposit ${d.id}: Hydra deposit ${depositTxId} submitted, awaiting CommitFinalized`
  );
  const outcome = await deps.awaitCommit(depositTxId, COMMIT_WAIT_MS);
  if (outcome === 'finalized') {
    await cas(d.id, 'committing', 'available');
    logger.info(`deposit ${d.id}: available in L2 (${depositTxId})`);
  } else if (outcome === 'expired') {
    const now = await prisma.deposit.findUniqueOrThrow({ where: { id: d.id } });
    await retryCommit(now, 'DEPOSIT_EXPIRED', deps);
  } // 'pending': resumeCommit settles it from the L2 snapshot
}

/** A `committing` row without a live wait (restart, lost WS): settle it from the L2 snapshot. */
async function resumeCommit(d: DepositRow, deps: DepositDeps): Promise<void> {
  if (d.fundsUnit && (await inL2(d.fundsUnit, deps))) {
    await cas(d.id, 'committing', 'available');
    return;
  }
  if (Date.now() - d.updatedAt.getTime() < COMMIT_WAIT_MS) return;
  await retryCommit(d, 'COMMIT_TIMEOUT', deps);
}

/** One pass over every deposit in flight. All state is in the DB, so it resumes after a restart. */
export async function pollDeposits(deps: DepositDeps): Promise<void> {
  const inBridge = await prisma.deposit.findMany({
    where: {
      OR: [
        { state: { in: ['btc_sent', 'bridge_processing'] } },
        { state: 'needs_attention', error: { in: BRIDGE_RESUMABLE } },
      ],
    },
  });
  for (const d of inBridge) {
    await advanceBridge(d, deps).catch((e) =>
      logger.warning(`deposit ${d.id} bridge step: ${message(e)}`)
    );
  }
  // Read `committing` before committing new ones, so a wait that just timed out is not judged twice.
  const committing = await prisma.deposit.findMany({
    where: { state: 'committing' },
  });
  for (const d of committing) {
    await resumeCommit(d, deps).catch((e) =>
      logger.warning(`deposit ${d.id} resume: ${message(e)}`)
    );
  }
  const ready = await prisma.deposit.findMany({
    where: { state: 'l1_confirmed' },
  });
  // ponytail: commits run one at a time inside the tick, so a CommitFinalized wait (~deposit
  // period) delays the other deposits' polling; move the wait out of the tick if that matters.
  for (const d of ready) await commitDeposit(d, deps);
}

/** Returns a runner that skips (joins) a call while the previous one is still in flight. */
export function singleFlight(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  return () =>
    (running ??= fn()
      .catch((e) => logger.error(`deposit poller: ${message(e)}`))
      .finally(() => {
        running = null;
      }));
}

export function startDepositPoller(deps: DepositDeps, intervalMs: number) {
  const tick = singleFlight(() => pollDeposits(deps));
  void tick(); // resume in-flight deposits right after boot
  return setInterval(tick, intervalMs);
}

// ---------- real dependencies ----------

/** The deposit key: a mnemonic handled like SEED (base address, account 0). */
export const depositWallet = () =>
  walletFromSeed(env.DEPOSIT_KEY, {
    network: env.NETWORK as Network,
    addressType: 'Base',
    accountIndex: 0,
  });

/** Startup check: DEPOSIT_ADDRESS is a bridge-compatible key address derived from DEPOSIT_KEY. */
export function assertDepositConfig(): void {
  assertDepositDestination(env.DEPOSIT_ADDRESS);
  if (depositWallet().address !== env.DEPOSIT_ADDRESS) {
    throw new Error('DEPOSIT_ADDRESS is not the base address of DEPOSIT_KEY');
  }
}

async function validatorRefUtxo(lucid: LucidEvolution): Promise<UTxO> {
  const [ref] = await lucid.utxosByOutRef([
    { txHash: env.VALIDATOR_REF, outputIndex: 0 },
  ]);
  if (!ref?.scriptRef) throw new Error('VALIDATOR_REF#0 not found on L1');
  return ref;
}

/**
 * The deposit's user funds UTxO at the validator on L1. Created once from the bridged UTxO
 * (signed by the admin and the deposit key): its validation token is named after that outRef, so
 * the same UTxO is found again after a crash or a Hydra recover, wherever its txHash#ix moved.
 */
async function fundsUtxoOnL1(
  lucid: LucidEvolution,
  d: DepositRow
): Promise<{ utxo: UTxO; unit: string }> {
  const local = _.cloneDeep(lucid);
  const validatorRef = await validatorRefUtxo(local);
  const { scriptAddress, scriptHash } = getValidatorDetails(
    validatorRef.scriptRef!,
    getNetworkFromLucid(local)
  );
  const bridgedRef: OutRef = {
    txHash: d.redeemTxHash!,
    outputIndex: d.redeemIndex!,
  };
  const unit = toUnit(scriptHash, validationTokenName(bridgedRef));
  const find = async () =>
    (await local.utxosAtWithUnit(scriptAddress, unit))[0] as UTxO | undefined;
  const existing = await find();
  if (existing) return { utxo: existing, unit };

  const ref = `${bridgedRef.txHash}#${bridgedRef.outputIndex}`;
  const [bridged] = await local.utxosByOutRef([bridgedRef]);
  if (!bridged) {
    throw new Error(
      `funds UTxO not at the validator and bridged UTxO ${ref} not on L1`
    );
  }
  if (
    bridged.address !== env.DEPOSIT_ADDRESS ||
    (bridged.assets[BTC_UNIT] ?? 0n).toString() !== d.receivedBaseUnits
  ) {
    throw new Error(
      `bridged UTxO ${ref} differs from the Koios-verified output`
    );
  }

  const txId = await withLock(async () => {
    local.selectWallet.fromSeed(env.SEED);
    const adminAddress = await local.wallet().address();
    const adminUtxos = selectUTxOs(await local.utxosAt(adminAddress), {
      lovelace: 5_000_000n,
    });
    if (adminUtxos.length === 0)
      throw new Error('admin wallet cannot cover the deposit tx');
    const { tx } = await deposit(
      local,
      {
        userAddress: d.userAddress,
        publicKey: '0'.repeat(64), // as /incremental-commit; the 2x validator ignores it
        amountsToDeposit: bridged.assets, // the BTC and the bridge's min-ADA, all locked (decision 4)
        lockDeposited: true,
        seedUtxo: bridged,
        walletUtxos: adminUtxos,
        validatorRef,
      },
      adminAddress
    );
    local.selectWallet.fromSeed(env.SEED);
    const signed = await local
      .fromTx(tx.toCBOR())
      .sign.withWallet()
      .sign.withPrivateKey(depositWallet().paymentKey)
      .complete();
    return signed.submit();
  });
  logger.info(`deposit ${d.id}: funds tx ${txId} submitted to L1`);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const utxo = await find().catch(() => undefined);
    if (utxo) return { utxo, unit };
  }
  throw new Error(`funds tx ${txId} not seen on L1 after 120 s`);
}

export const depositDeps = (lucid: LucidEvolution): DepositDeps => ({
  bridge: wanbridge,
  snapshot: () => fetchSnapshot(env.ADMIN_NODE_API_URL),
  fundsUtxo: (d) => fundsUtxoOnL1(lucid, d),
  submitCommit: async (funds, beforeSubmit) => {
    const local = _.cloneDeep(lucid);
    local.selectWallet.fromSeed(env.SEED);
    const adminAddress = await local.wallet().address();
    const validatorRef = await validatorRefUtxo(local);
    const blueprint = await buildIncrementalCommitBlueprint(local, {
      adminAddress,
      depositedUtxo: funds,
      validatorRefUtxo: validatorRef,
    });
    // The ref-script UTxO goes in the /commit context so Hydra resolves the script (incremental-commit.ts).
    return submitCommit(
      local,
      `${env.ADMIN_NODE_API_URL}/commit`,
      [funds, validatorRef],
      blueprint,
      beforeSubmit
    );
  },
  awaitCommit: (depositTxId, timeoutMs) =>
    awaitCommitFinalized(env.ADMIN_NODE_WS_URL, depositTxId, timeoutMs),
  recover: async (depositTxId) => {
    await axios.delete(`${env.ADMIN_NODE_API_URL}/commits/${depositTxId}`, {
      timeout: 30_000,
    });
  },
});
