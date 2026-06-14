# Draft bug report for `cardano-scaling/hydra`

> Copy/paste into a new issue at https://github.com/cardano-scaling/hydra/issues. Fill in the
> `<...>` placeholders (tx ids / closed datum) from a real run before filing.

---

**Title:** `Fanout` fails with `FailedToConstructPartialFanoutTx` for a head whose decommitted UTxO is script-locked (2.2.0)

**hydra-node version:** 2.2.0
**cardano-node:** 11.0.1, network: preprod (PV11)

## Summary

A single-party head that has performed at least one **incremental decommit** of a
**script-locked** UTxO cannot be fanned out. `Close` succeeds and `ReadyToFanout` fires, but
`Fanout` repeatedly emits `PostTxOnChainFailed { postTxError = FailedToConstructPartialFanoutTx }`
and never emits `HeadIsFinalized`. The head is stuck `Closed`.

The same flow with **no prior decommit** fanouts cleanly, so the trigger is specifically a
finalized decommit present in the closed snapshot.

## Steps to reproduce

1. Open a head and add funds via deposits (incremental commits).
2. `POST /decommit` a UTxO that is **locked by a Plutus validator** (i.e. the decommit tx spends a
   script output and runs the script). Wait for `DecommitFinalized` (the decrement is observed on
   L1; the on-chain head version bumps).
3. `Close`. Observe `HeadIsClosed`, then `ReadyToFanout` after the contestation deadline.
4. `Fanout`.

## Observed

```
PostTxOnChainFailed { postTxError = FailedToConstructPartialFanoutTx }   (repeated, ~every block)
PartialFanoutFailed { reason = ... }                                     (CardanoChainLog)
# the failing partial-fanout candidate runs the decommitted UTxO's validator:
ScriptWitnessIndexTxIn 0 FAIL ... Script hash: <validator> ... PlutusV3
Script evaluation error: The machine terminated because of an error ...
```

`HeadIsFinalized` is never emitted.

## Expected

A decommit that has already settled on L1 should not be re-applied at fanout. `Fanout` should
distribute the remaining head UTxOs (without spending/validating the already-decommitted output)
and emit `HeadIsFinalized`.

## Analysis (source, tag 2.2.0)

- `Hydra/HeadLogic.hs` `emitNextFanoutStep` keeps the closed snapshot's `utxoToDecommit` whenever
  `snapshotVersion == version`. After a decommit finalizes with no subsequent L2 activity, the
  latest confirmed snapshot's version equals the current on-chain version, so the **already-settled**
  `utxoToDecommit` is included in `FanoutTx`.
- `Hydra/Chain/Direct/Handlers.hs` `findFittingFanoutTx` → `partialFanout` then builds a tx that
  spends that UTxO; for a script-locked UTxO this runs the validator. The node-constructed fanout
  tx cannot satisfy an application-specific validator, so evaluation fails at every chunk size and
  `findFittingFanoutTx` throws `FailedToConstructPartialFanoutTx`.

We confirmed (a) the validator is executed during fanout (Plutus `Script evaluation error` in the
`PartialFanoutFailed` trace) and (b) it is the "no chunk fits" path (no structural
`PartialFanoutError` reason), i.e. the script genuinely cannot be satisfied by the fanout tx.

A client-side workaround of pushing a no-op L2 tx before `Close` does **not** help: an L2 tx does
not change the on-chain head version, so `snapshotVersion == version` still holds and the gate
still includes the decommit.

## Attachments to add before filing

- Closed-head datum (constructor 3) for `<head id>`.
- The two decrement txs: `<decrement tx id(s)>`.
- A `--since`-bounded `CardanoChainLog` snippet showing `PartialFanoutFailed` + the script error.
