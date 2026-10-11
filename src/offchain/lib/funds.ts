import { Data, LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { FundsDatum, FundsDatumT } from './types';
import { dataAddressToBech32 } from './utils';

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

/** The bech32 address a funds UTxO pays out to (its FundsDatum.addr), or null without a FundsDatum. */
export function fundsOwnerOf(lucid: LucidEvolution, u: UTxO): string | null {
  const d = fundsDatumOf(u);
  return d && dataAddressToBech32(lucid, d.addr);
}

/**
 * payableInL2: per unit, the max spendable over the user funds UTxOs (one payment spends exactly one
 * funds UTxO). Merchant UTxOs, control tokens and zero amounts are left out.
 */
export function payableInL2(
  utxos: UTxO[],
  isControlToken: (unit: string) => boolean
): Record<string, string> {
  const payable: Record<string, string> = {};
  for (const utxo of utxos) {
    const datum = fundsDatumOf(utxo);
    if (!datum || datum.funds_type === 'Merchant') continue;
    for (const unit of Object.keys(utxo.assets)) {
      if (isControlToken(unit)) continue;
      const v = spendable(utxo, datum, unit);
      if (v > BigInt(payable[unit] ?? '0')) payable[unit] = v.toString();
    }
  }
  return payable;
}

/** What a user funds UTxO can pay in `unit`: lovelace keeps `locked_deposit` back. */
export function spendable(u: UTxO, d: FundsDatumT, unit: string): bigint {
  const qty = u.assets[unit] ?? 0n;
  return unit === 'lovelace' ? qty - d.locked_deposit : qty;
}
