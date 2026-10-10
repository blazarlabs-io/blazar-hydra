/**
 * BTC deposit lifecycle as pure functions.
 *
 *   CREATED -> BTC_SENT -> BRIDGE_PROCESSING -> L1_CONFIRMED -> COMMITTING -> AVAILABLE_L2
 *
 * Failure states:
 * - TIMEOUT: bridge has not reported Success within the deadline. Needs attention, not final:
 *   a later Success/Trusteeship/Refund still moves it on, so arriving funds are never orphaned.
 * - TRUSTEESHIP: bridge needs manual handling. A later Success (manual completion) or Refund moves it on.
 * - REFUND: final.
 *
 * `applyEvent` is forward-only and idempotent: an event that is already reflected returns the same
 * object (reference-equal, so the caller can skip the write); a conflicting or out-of-order event
 * throws DepositTransitionError. Nothing here credits a balance.
 */
import type { BridgeStatus } from './client';
import type { OutRef } from './verify';

export const DepositState = {
  CREATED: 'CREATED',
  BTC_SENT: 'BTC_SENT',
  BRIDGE_PROCESSING: 'BRIDGE_PROCESSING',
  L1_CONFIRMED: 'L1_CONFIRMED',
  COMMITTING: 'COMMITTING',
  AVAILABLE_L2: 'AVAILABLE_L2',
  TRUSTEESHIP: 'TRUSTEESHIP',
  REFUND: 'REFUND',
  TIMEOUT: 'TIMEOUT',
} as const;
export type DepositState = keyof typeof DepositState;

/** Fields the state machine reads and writes; flat and nullable so a Prisma row fits as is. */
export type Deposit = {
  state: DepositState;
  btcTxid?: string | null;
  btcVout?: number | null;
  btcSentAt?: Date | null;
  /** Cardano tx that minted the bridged BTC = L1 outRef tx hash. */
  redeemHash?: string | null;
  l1OutputIndex?: number | null;
  l1Quantity?: bigint | null;
  commitTxId?: string | null;
};

export type DepositEvent =
  | { type: 'BTC_SENT'; btcTxid: string; vout: number; at: Date }
  | { type: 'BRIDGE_STATUS'; status: BridgeStatus }
  | { type: 'TICK'; now: Date; timeoutMs: number }
  | { type: 'L1_VERIFIED'; outRef: OutRef; quantity: bigint }
  | { type: 'COMMIT_STARTED'; commitTxId: string }
  | { type: 'COMMIT_CONFIRMED'; commitTxId: string };

export class DepositTransitionError extends Error {}

const WAITING_ON_BRIDGE: DepositState[] = [
  'BTC_SENT',
  'BRIDGE_PROCESSING',
  'TIMEOUT',
  'TRUSTEESHIP',
];

function reject(d: Deposit, ev: DepositEvent, why = 'not allowed'): never {
  throw new DepositTransitionError(
    `${ev.type} ${why} in ${d.state}: ${JSON.stringify(ev, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v
    )}`
  );
}

/** Already recorded: same input is a no-op, a different one is a conflict. */
function same<T extends Deposit>(d: T, ev: DepositEvent, equal: boolean): T {
  return equal ? d : reject(d, ev, 'conflicts with recorded data');
}

export function applyEvent<T extends Deposit>(d: T, ev: DepositEvent): T {
  switch (ev.type) {
    case 'BTC_SENT':
      if (d.btcTxid != null) {
        return same(d, ev, d.btcTxid === ev.btcTxid && d.btcVout === ev.vout);
      }
      if (d.state !== 'CREATED') return reject(d, ev);
      return {
        ...d,
        state: 'BTC_SENT',
        btcTxid: ev.btcTxid,
        btcVout: ev.vout,
        btcSentAt: ev.at,
      };

    case 'BRIDGE_STATUS': {
      if (d.btcTxid == null) return reject(d, ev, 'before BTC_SENT');
      const s = ev.status;
      if (s.status === 'Success') {
        if (d.redeemHash != null)
          return same(d, ev, d.redeemHash === s.redeemHash);
        if (!WAITING_ON_BRIDGE.includes(d.state)) return reject(d, ev);
        return { ...d, state: 'BRIDGE_PROCESSING', redeemHash: s.redeemHash };
      }
      if (d.redeemHash != null) {
        // After Success, NotFound/Processing are stale reads; Trusteeship/Refund contradict it.
        return s.status === 'NotFound' || s.status === 'Processing'
          ? d
          : reject(d, ev, 'contradicts recorded Success');
      }
      switch (s.status) {
        case 'NotFound':
          return d;
        case 'Processing':
          return d.state === 'BTC_SENT'
            ? { ...d, state: 'BRIDGE_PROCESSING' }
            : d;
        case 'Trusteeship':
          return d.state === 'TRUSTEESHIP' || d.state === 'REFUND'
            ? d
            : { ...d, state: 'TRUSTEESHIP' };
        case 'Refund':
          return d.state === 'REFUND' ? d : { ...d, state: 'REFUND' };
      }
      return reject(d, ev);
    }

    case 'TICK': {
      const waiting = d.state === 'BTC_SENT' || d.state === 'BRIDGE_PROCESSING';
      const overdue =
        d.btcSentAt != null &&
        ev.now.getTime() - d.btcSentAt.getTime() > ev.timeoutMs;
      // Only the bridge leg times out; once redeemHash is known, L1 verification is deterministic.
      return waiting && d.redeemHash == null && overdue
        ? { ...d, state: 'TIMEOUT' }
        : d;
    }

    case 'L1_VERIFIED':
      if (d.l1OutputIndex != null) {
        return same(
          d,
          ev,
          d.redeemHash === ev.outRef.txHash &&
            d.l1OutputIndex === ev.outRef.outputIndex &&
            d.l1Quantity === ev.quantity
        );
      }
      if (
        d.state !== 'BRIDGE_PROCESSING' ||
        d.redeemHash !== ev.outRef.txHash
      ) {
        return reject(d, ev);
      }
      return {
        ...d,
        state: 'L1_CONFIRMED',
        l1OutputIndex: ev.outRef.outputIndex,
        l1Quantity: ev.quantity,
      };

    case 'COMMIT_STARTED':
      if (d.commitTxId != null)
        return same(d, ev, d.commitTxId === ev.commitTxId);
      if (d.state !== 'L1_CONFIRMED') return reject(d, ev);
      return { ...d, state: 'COMMITTING', commitTxId: ev.commitTxId };

    case 'COMMIT_CONFIRMED':
      if (d.state === 'AVAILABLE_L2')
        return same(d, ev, d.commitTxId === ev.commitTxId);
      if (d.state !== 'COMMITTING' || d.commitTxId !== ev.commitTxId) {
        return reject(d, ev);
      }
      return { ...d, state: 'AVAILABLE_L2' };
  }
}
