import { Assets, Data, LucidEvolution, UTxO } from '@lucid-evolution/lucid';
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

/**
 * Gate before Close: only admin collateral and user funds may remain. User funds carry the
 * validation token minted on L1 at deposit, so the fanout gives it back intact. Merchant funds
 * carry a token minted inside L2, which the L1 head output does not hold: fanning one out breaks
 * the head's value conservation (H4), so merchants are withdrawn (token burned in L2) first.
 */
export function assertOnlyUserFunds(snapshot: UTxO[], adminAddress: string): void {
  const blocking = snapshot.filter((u) => {
    if (u.address === adminAddress) return false;
    const d = fundsDatumOf(u);
    return !d || d.funds_type === 'Merchant';
  });
  if (blocking.length > 0) {
    const refs = blocking
      .map((u) => `${u.txHash}#${u.outputIndex}${fundsDatumOf(u) ? ' (merchant funds)' : ''}`)
      .join(', ');
    throw new Error(`Head still holds UTxOs that cannot leave through the fanout: ${refs}`);
  }
}

/**
 * Gate before Close: the L1 head output must hold exactly the validation tokens (policy
 * `policyId`) that the L2 snapshot holds. A token burned in L2 but still in the head output on L1,
 * or minted in L2 and absent from L1, makes every fanout fail (H4), so such a head is not closed.
 */
export function assertHeadTokensMatch(l1HeadAssets: Assets, snapshot: UTxO[], policyId: string): void {
  const add = (acc: Record<string, bigint>, assets: Assets) => {
    for (const [unit, qty] of Object.entries(assets)) {
      if (unit.startsWith(policyId)) acc[unit] = (acc[unit] ?? 0n) + qty;
    }
    return acc;
  };
  const l1 = add({}, l1HeadAssets);
  const l2 = snapshot.reduce((acc, u) => add(acc, u.assets), {} as Record<string, bigint>);
  const differ = [...new Set([...Object.keys(l1), ...Object.keys(l2)])].filter(
    (unit) => (l1[unit] ?? 0n) !== (l2[unit] ?? 0n)
  );
  if (differ.length > 0) {
    throw new Error(
      `The head output on L1 and the L2 snapshot hold different validation tokens (${differ.join(', ')}): its fanout would fail (H4), not closing`
    );
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
