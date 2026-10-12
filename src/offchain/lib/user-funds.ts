import { fromUnit, LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import type { HydraHandler } from './hydra';
import { fundsDatumOf, fundsOwnerOf } from './funds';
import { getNetworkFromLucid, getValidatorDetails } from './utils';
import { recreateFunds } from '../tx-builders/recreate-funds';
import { withdrawUsersOnL1 } from '../tx-builders/withdraw-user-l1';

/**
 * User funds carry a validation token minted on L1 at deposit. Burning it inside L2 leaves it in
 * the L1 head output, and the head can then never fan out (H4 HeadValueIsNotPreserved). So user
 * funds leave the head unchanged (an intact decommit while the head is open, or the fanout at
 * close) and the token is burned on L1 by `UserWithdraw`, which pays the owner.
 */
type UserFundsOps = {
  /** Decommit the UTxO unchanged (AddFunds recreation) and wait until it left L2. */
  decommitIntact: (fund: UTxO) => Promise<void>;
  /** The same funds (same validation token) once they sit at the validator on L1. */
  findOnL1: (fund: UTxO) => Promise<UTxO>;
  /** One L1 UserWithdraw paying each owner, confirmed. */
  withdrawOnL1: (funds: UTxO[]) => Promise<{ txHash: string; cborHex: string }>;
};

// ponytail: fixed batch for the L1 withdraw; tune if a close ever needs bigger transactions.
const L1_WITHDRAW_BATCH = 10;

/**
 * While the head is open: one funds UTxO at a time, end to end (decommit intact, wait for it on
 * L1, pay its owner). hydra-node keeps one decommit in flight until its decrement lands on L1, and
 * a fund that already left L2 is paid before the next one moves, so a later failure strands nothing.
 */
async function takeUserFundsOut(ops: UserFundsOps, funds: UTxO[]) {
  const notUser = funds.find((u) => {
    const d = fundsDatumOf(u);
    return !d || d.funds_type === 'Merchant';
  });
  if (notUser) {
    throw new Error(
      `${notUser.txHash}#${notUser.outputIndex} is not user funds (merchant funds hold a token minted in L2 and are withdrawn inside the head)`
    );
  }
  const paid = [];
  for (const fund of funds) {
    await ops.decommitIntact(fund);
    paid.push(await ops.withdrawOnL1([await ops.findOnL1(fund)]));
  }
  return paid;
}

/** After the funds reached L1 (intact decommit or fanout): pay the owners, burning the tokens on L1. */
async function payOutOnL1(ops: Pick<UserFundsOps, 'findOnL1' | 'withdrawOnL1'>, funds: UTxO[]) {
  const onL1: UTxO[] = [];
  for (const fund of funds) onL1.push(await ops.findOnL1(fund));
  const paid = [];
  for (let i = 0; i < onL1.length; i += L1_WITHDRAW_BATCH) {
    paid.push(await ops.withdrawOnL1(onL1.slice(i, i + L1_WITHDRAW_BATCH)));
  }
  return paid;
}

/**
 * User funds of `owner` already at the validator on L1: a withdraw whose L1 payout did not run, or
 * a deposit not committed to a head. Merchant funds are never paid out by this path.
 */
function ownerFundsOnL1(lucid: LucidEvolution, atValidator: UTxO[], owner: string): UTxO[] {
  return atValidator.filter((u) => {
    const d = fundsDatumOf(u);
    return !!d && d.funds_type !== 'Merchant' && fundsOwnerOf(lucid, u) === owner;
  });
}

type L1Context = { seed: string; adminAddress: string; validatorRef: UTxO };

/** The L1 side: find funds at the validator by their token, pay their owners (Kupo/Ogmios via Lucid). */
function l1PayoutOps(lucid: LucidEvolution, ctx: L1Context): Pick<UserFundsOps, 'findOnL1' | 'withdrawOnL1'> {
  if (!ctx.validatorRef.scriptRef) throw new Error('Validator reference UTxO has no script');
  const { scriptAddress, scriptHash } = getValidatorDetails(
    ctx.validatorRef.scriptRef,
    getNetworkFromLucid(lucid)
  );
  const tokenOf = (fund: UTxO) => {
    const unit = Object.keys(fund.assets).find(
      (u) => u !== 'lovelace' && fromUnit(u).policyId === scriptHash
    );
    if (!unit) throw new Error(`${fund.txHash}#${fund.outputIndex} has no validation token`);
    return unit;
  };
  return {
    async findOnL1(fund) {
      // Until the decrement lands, the token is still inside the L1 head output; wait for it at the
      // validator address (a decrement or fanout is a block or two on preprod).
      const unit = tokenOf(fund);
      const deadline = Date.now() + 600_000;
      for (;;) {
        const [onL1] = await lucid.utxosAtWithUnit(scriptAddress, unit);
        if (onL1) return onL1;
        if (Date.now() > deadline) throw new Error(`${unit} did not reach the validator on L1`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    },
    async withdrawOnL1(funds) {
      lucid.selectWallet.fromSeed(ctx.seed);
      const tx = await withdrawUsersOnL1(lucid, {
        fundUtxos: funds,
        validatorRef: ctx.validatorRef,
        adminAddress: ctx.adminAddress,
      });
      const signed = await tx.sign.withWallet().complete();
      const txHash = await signed.submit();
      await lucid.awaitTx(txHash);
      return { txHash, cborHex: signed.toCBOR() };
    },
  };
}

/** All operations: hydra-node for the intact decommit, plus the L1 side. */
function userFundsOps(
  lucid: LucidEvolution,
  hydra: HydraHandler,
  ctx: L1Context & { adminKey: string; hydraKey: string; decommitUrl: string }
): UserFundsOps {
  return {
    ...l1PayoutOps(lucid, ctx),
    async decommitIntact(fund) {
      const collateral = (await hydra.getSnapshot()).find((u) => u.address === ctx.adminAddress);
      if (!collateral) throw new Error('No admin collateral UTxO found in L2');
      const { tx } = await recreateFunds(lucid, {
        fundUtxo: fund,
        adminCollateral: collateral,
        adminKey: ctx.adminKey,
        hydraKey: ctx.hydraKey,
      });
      lucid.selectWallet.fromSeed(ctx.seed);
      const signed = await lucid.fromTx(tx.toCBOR()).sign.withWallet().complete();
      await hydra.decommit(ctx.decommitUrl, signed.toCBOR());
      await hydra.awaitDecommit([fund]);
    },
  };
}

export { l1PayoutOps, ownerFundsOnL1, payOutOnL1, takeUserFundsOut, userFundsOps, UserFundsOps };
