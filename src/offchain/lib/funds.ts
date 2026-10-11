import { Data, UTxO } from '@lucid-evolution/lucid';
import { FundsDatum, FundsDatumT } from './types';

/**
 * Head-snapshot UTxOs that carry a Blazar FundsDatum (user or merchant), excluding the admin's own
 * UTxOs. These are the funds that must be settled (decommitted) before a head can be safely discarded.
 */
export function findFundUtxos(snapshot: UTxO[], adminAddress: string): UTxO[] {
  return snapshot.filter((u) => {
    if (u.address === adminAddress || !u.datum) return false;
    try {
      Data.from<FundsDatumT>(u.datum, FundsDatum);
      return true;
    } catch {
      return false;
    }
  });
}

/** Throws unless the head holds no user/merchant fund UTxOs (only admin collateral may remain). */
export function assertFundsEmpty(snapshot: UTxO[], adminAddress: string): void {
  const funds = findFundUtxos(snapshot, adminAddress);
  if (funds.length > 0) {
    const refs = funds.map((u) => `${u.txHash}#${u.outputIndex}`).join(', ');
    throw new Error(`Head is not funds-empty: ${funds.length} fund UTxO(s) remain (${refs})`);
  }
}

/** The Blazar FundsDatum of a UTxO, or null when it has none. */
export function fundsDatumOf(u: UTxO): FundsDatumT | null {
  if (!u.datum) return null;
  try {
    return Data.from<FundsDatumT>(u.datum, FundsDatum);
  } catch {
    return null;
  }
}

/** What a user funds UTxO can pay in `unit`: lovelace keeps `locked_deposit` back. */
export function spendable(u: UTxO, d: FundsDatumT, unit: string): bigint {
  const qty = u.assets[unit] ?? 0n;
  return unit === 'lovelace' ? qty - d.locked_deposit : qty;
}
