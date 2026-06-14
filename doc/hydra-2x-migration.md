# Hydra 2.x Migration & Operations

This document describes how blazar-hydra runs on **Hydra 2.x** (hydra-node `2.2.0`) after
the Cardano **van Rossem** intra-era hard fork to **Protocol Version 11 (PV11)** on Preprod
(2026-06-10). It captures the architecture, the funding model, the protocol-parameter
requirements, node configuration, and the operational runbook. Read this alongside
[`requirements_and_design.md`](./requirements_and_design.md) and
[`api-integration.md`](./api-integration.md).

## Why the migration

PV11 is the first protocol version after the hard fork. Two things had to change:

- **cardano-node `11.0.1`** — first PV11-capable release.
- **hydra-node `2.2.0`** — Hydra 2.x ("directly open heads"). The 1.x commit-at-Init model
  is gone; funds enter an already-open head via **deposits** (incremental commits).

This unlocks the "v2" capability that the original design deferred (see
[Incremental Commits](https://github.com/cardano-scaling/hydra/issues/199)): a head no longer
has to be recycled daily to take in new deposits — funds can be added to a running head.

## Architecture

```
┌─────────────┐   socket    ┌──────────────┐   ws/http   ┌──────────────┐   https   ┌───────┐
│ cardano-node │◀───────────▶│ hydra-node-1 │◀───────────▶│ blazar-hydra │◀─────────▶│ caddy │
│   11.0.1     │ node.socket │    2.2.0     │  :4001      │   (this API) │           │ (TLS) │
└─────────────┘             └──────────────┘             └──────────────┘           └───────┘
        ▲                                                        │
        └────────────────── L1 (preprod) ◀── Blockfrost (Lucid) ─┘
```

- **cardano-node** follows the L1 chain and exposes a local UNIX socket
  (`/ipc/node.socket`, shared with hydra-node as `/devnet/node.socket`).
- **hydra-node** runs the head; it reads L1 through the **local cardano-node socket**
  (`--node-socket` + `--testnet-magic 1`).
- **blazar-hydra** (this server) builds L1 transactions through **Blockfrost** (Lucid
  Evolution provider) and drives the head over the hydra-node WebSocket/HTTP API.

### Do NOT use hydra-node Blockfrost mode

hydra-node 2.x can follow the chain directly from Blockfrost (`--blockfrost`), which avoids
running a cardano-node. On Preprod with the **free Blockfrost tier this is not reliable**:
the node's chain-follow *drift* oscillates ~40–90s. The "unsynced" threshold is
`contestation-period / 2`; once drift exceeds it the node emits
`RejectedInputBecauseUnsynced` and rejects `Init`, `Close`, and deposit observation. A local
cardano-node keeps drift ~0, so use the socket. (If you must use Blockfrost mode, use a paid
tier and verify drift stays well under the unsynced threshold.)

## Funding model (Hydra 2.x)

In 2.x the head opens **empty** and funds are added by deposits. There is **no commit phase**
and **no `Abort`** (the `Abort`/`HeadIsInitializing`/`HeadIsAborted`/`Committed` outputs are
gone). The full funding flow (`POST /open-head` → background `finalizeOpenHead`):

1. **Init** → the node opens an empty head and emits `HeadIsOpen`. `Init` on an already-open
   head returns `CommandFailed`, which we treat as a no-op (idempotent).
2. **Merge** same-datum deposit UTxOs at the Blazar validator into one UTxO per datum (a
   datum encodes the owner; different owners can't be merged).
3. **Commit each fund UTxO** as a deposit: `POST /commit` with a `PartialCommit` blueprint
   (the Blazar validator is a withdraw-zero/forwarding validator), sign + submit the deposit
   tx to L1, then await `CommitFinalized`.
4. **Commit one pure-ADA admin collateral UTxO** (≥10 ADA) into L2 via a **simple commit**
   (no blueprint). `/pay` and `/withdraw` need an admin-owned L2 UTxO for collateral; Hydra
   1.x committed this at Init, so the 2.x flow must deposit it explicitly. The collateral
   **must be pure ADA** — the ledger rejects collateral carrying native assets
   (`CollateralContainsNonADA`). When the admin wallet has no pure-ADA UTxO (common after a few
   runs, when the test tokens are spread across change outputs), funding **creates one** by
   paying ADA to the admin address before committing.
5. Head status → `RUNNING`.

### Deposit lifecycle and timing

Each deposit goes through:

```
CommitRecorded → DepositActivated → CommitApproved → CommitFinalized
```

A deposit is **not** finalized immediately. With deposit-period `DP`, the node picks it up
**after `DP`** at the earliest and **`2·DP`** at the latest (recoverable after `3·DP`). So
funding waits roughly `DP … 2·DP` **per deposit**, sequentially. Status path:
`INITIALIZING → MERGING → COMMITTING → RUNNING`.

> Funding does N sequential deposits when N distinct datums (owners) are present at the
> validator, plus 1 for the admin collateral. Count the distinct datums to predict the time:
> `cardano-cli query utxo --address <validator> --testnet-magic 1 --socket-path /ipc/node.socket`.

## L2 protocol parameters (cost models) — critical

The hydra-node validates L2 transactions against `--ledger-protocol-parameters`
(`protocol-parameters.json`). blazar builds L2 transactions with Lucid, which computes the
`script_data_hash` using the **cost models Lucid gets from Blockfrost (current preprod PV11)**.

**The cost models in `protocol-parameters.json` MUST match the current preprod cost models**,
otherwise the node rejects every script tx with:

```
ConwayUtxowFailure (ScriptIntegrityHashMismatch ...)
```

PV11 changed the PlutusV3 cost model (it grew from 297 to **350** entries on Preprod). A
stale file produces a hash mismatch on `/pay` and the `/withdraw` decommit.

> The cost models are **baked into a head at `Init`**. Changing the file and restarting the
> node does **not** affect an already-open head — you must open a **fresh** head.

Regenerate the cost models from the exact source Lucid uses (Blockfrost), preserving the L2
customizations (`txFeeFixed: 0`, `txFeePerByte: 0`, `executionUnitPrices: 0`, the large
`maxTxExecutionUnits`, `protocolVersion.major: 11`):

```bash
KEY=<blockfrost-preprod-project-id>
CM=$(curl -s -H "project_id: $KEY" \
  "https://cardano-preprod.blockfrost.io/api/v0/epochs/latest/parameters" | jq '.cost_models_raw')
cp protocol-parameters.json protocol-parameters.json.bak
jq --argjson cm "$CM" '.costModels = $cm' protocol-parameters.json.bak > protocol-parameters.json
# sanity: PlutusV3 length should match preprod (350 at PV11), fees should be 0
jq '.costModels.PlutusV3 | length' protocol-parameters.json
```

## hydra-node configuration

```
--node-socket          /devnet/node.socket
--testnet-magic        1
--ledger-protocol-parameters /devnet/protocol-parameters.json
--hydra-scripts-tx-id  <2.2.0 published scripts>
--contestation-period  120s     # unsynced threshold = CP/2 = 60s
--deposit-period       300s     # 3*DP deadline must exceed the deposit lifecycle (~6-7 min)
```

- **contestation-period** drives the `unsynced` threshold (`CP/2`) and gates decommit/fanout
  settlement. `120s` (60s threshold) is the validated value. Lowering it to `60s` (30s
  threshold) proved **too tight on preprod** — decommits stopped reaching `DecommitFinalized`
  — so keep CP at 120s unless you have headroom to spare.
- **deposit-period** governs how long a deposit takes to finalize (`DP … 2·DP`) and sets the
  deposit deadline (`3·DP`). DP must be large enough in **absolute** terms that `3·DP` exceeds
  the preprod deposit lifecycle (~6–7 min): `DP=300s` (15 min deadline) works; `DP=120s`
  (6 min deadline) hit `DepositExpired`. `300s` ≈ 5–10 min/deposit.
- `ReadyToFanout` **and** `DecommitFinalized` only fire **after** the contestation deadline (a
  decommit/decrement settles like a fanout), so the off-chain waits for them must comfortably
  exceed the contestation period (the handlers wait 660s). A 120s wait against a 120s
  contestation period is right at the edge and times out intermittently.

## Endpoint behavior in 2.x

| Endpoint | 2.x behavior |
|---|---|
| `POST /deposit` | Locks user funds at the Blazar validator on L1 (unchanged). |
| `POST /open-head` | `Init` opens an **empty** head, returns `{operationId}`; funding runs async (deposits + admin collateral). |
| `GET /state?id=` | `INITIALIZING → MERGING → COMMITTING → RUNNING` (or `CLOSING/CLOSED/FAILED`). |
| `GET /query-funds` | L1 (validator) + L2 (head snapshot) funds. |
| `POST /pay-merchant` | Off-chain L2 payment; builds the tx, sends `NewTx`, waits for `TxValid`. |
| `POST /incremental-commit` | Adds funds to a **running** head (deposit + blueprint). |
| `POST /withdraw` / `incremental-decommit` | Settles L2→L1 via the hydra-node **`/decommit`** endpoint (not an L1 submit). |
| `POST /close-head` | Decommit merchant funds → `Close` → wait `ReadyToFanout` (past contestation) → `Fanout` → `CLOSED`. |

## Off-chain changes made for 2.x

- `HydraHandler` rewritten around a tag-accurate `waitForTag` (replaces the legacy
  `listen()`); deposit lifecycle (`commit`/`recover`), `Tx ConwayEra` envelopes,
  `--blockfrost`/socket agnostic. The WebSocket **auto-reconnects** and re-attaches the active
  `waitForTag` handler — Hydra drops idle sockets, and a long wait (decommit/fanout
  finalization, ~30s–minutes) would otherwise miss the event the node emits while the socket
  is down (the cause of `Timeout waiting for tag 'DecommitFinalized'` even though the node
  finalized the decommit).
- `commit-funds.ts`: always `PartialCommit` + `CombinedPartialCommit`, validator ref as a
  reference input.
- `open-head.ts`: directly-open head, deposit-based funding, **admin collateral commit** (the
  collateral is pure-ADA only; funding creates a pure-ADA UTxO if the admin wallet has none).
- `pay-merchant.ts`: guard the L2 snapshot scan (skip admin/non-FundsDatum UTxOs); fixed a
  variable-shadowing bug; `sendTx` now returns the tag string.
- `withdraw.ts` / `withdraw-merchant.ts`: a user withdraw routes through hydra `/decommit`
  (reading funds from the **L2 snapshot**, script attached inline). The shared builder is
  **kind-aware**: user funds use the `UserWithdraw` redeemer with the `CombinedWithdraw`
  withdraw-zero pattern and a **no-datum** payout output, while merchant funds use
  `MerchantWithdraw` with an OutRef-datum output (`validate_combined_withdraw` vs
  `validate_merchant_withdraw`).
- `close-head.ts`: single `await close()` (removed a racy retry loop); `Close` and `Fanout`
  waits raised to 300s (preprod block times intermittently exceeded the old 60s/120s even when
  the tx posts fine). Before `Close` it submits a **no-op L2 self-transfer**
  (`refreshSnapshotBeforeClose`) to advance the head to a fresh confirmed snapshot — correct
  client behavior so `Close` doesn't capture a stale snapshot. **Known limitation:** on a head
  that had an incremental decommit this still does **not** let the head reach `Fanout` — see
  ["Known limitation: fanout after decommit"](#known-limitation-fanout-after-decommit).
- `server.ts`: the `bigint` body middleware now parses only a **non-empty** body. After
  `express.raw`, an empty body is an empty (truthy) `Buffer`, so `JSONbig.parse("")` threw and
  surfaced as a default-Express `[object Object]` 500 on body-less POSTs like `/close-head`
  (which reads only `req.query`).
- `awaitDecommit` no longer waits for the generic `DecommitFinalized` tag — it **polls the L2
  snapshot until the decommitted UTxOs are gone**. With back-to-back decommits (a `/withdraw`
  then the close's merchant decommit), the tag wait would match the *other* decommit's late
  event and return early, so `Close` went out while this decommit was still pending — leaving a
  `utxoToDecommit` in the closing snapshot and making `Fanout` fail with
  `FailedToConstructPartialFanoutTx`. The poll is WS-independent and specific to each decommit.

## Known limitation: fanout after decommit

A head that has had an **incremental decommit** (every `/withdraw`, and the merchant decommit in
`/close-head`) currently **cannot reach `Fanout`** on hydra-node `2.2.0`. The full flow up to and
including `Close` works — funds are correctly distributed to L1 by the decommits themselves — but
the head stays `Closed` and never finalizes, so the leftover admin-collateral UTxO (~50 ADA, see
the capped collateral above) is not returned, and the stuck head blocks new `/open-head` until the
node head state is wiped.

**Root cause (confirmed against hydra-node `2.2.0` source + live capture).** When a decommit
finalizes, its `utxoToDecommit` stays in the latest confirmed snapshot. At fanout, hydra-node's
`emitNextFanoutStep` only drops it when `snapshotVersion /= version`; here they are equal, so the
decommitted UTxO is included and `findFittingFanoutTx` builds a **partial-fanout** tx that spends
that **Blazar-validator-locked** UTxO and runs the validator. The validator can't be satisfied by
the node-built fanout tx, so script evaluation fails at every chunk size and the node throws
`FailedToConstructPartialFanoutTx` (observed in the node log as repeated
`PostTxOnChainFailed: {FailedToConstructPartialFanoutTx}` + `Script evaluation error`, with
`HeadIsFinalized` never emitted). `FailedToConstructPartialFanoutTx` is **new in 2.2.0** (the
partial-fanout rewrite).

**Why the client-side `refreshSnapshotBeforeClose` no-op does not fix it.** Advancing to a fresh
snapshot via an L2 tx keeps `snapshotVersion == version` (an L2 tx doesn't bump the on-chain head
version), so the version gate still includes the `utxoToDecommit`. There is no client-side way to
make the two versions differ, so this needs a **hydra-node fix** (don't re-run the script for an
already-settled decommit at fanout) or a **validator redesign** (a spend path the node's fanout tx
can satisfy). Tracked upstream: file against `cardano-scaling/hydra` with the closed datum + the
two decrement txs (no existing issue names the symbol as of 2026-06-14).

**Operational impact / workaround.** All user and merchant funds settle correctly (the decommits
are what move them to L1); only head cleanup is affected. To unblock new heads after a stuck close:
`docker compose stop hydra-node-1 && rm -rf ./persistence/alice && docker compose up -d hydra-node-1`.

## Operational runbook

Build/deploy is performed on the host running the stack (not locally).

```bash
# 1. Build + push the blazar image (after code changes)
docker build -t <image>:hydra2x . && docker push <image>:hydra2x

# 2. On the host: ensure protocol-parameters.json has current preprod cost models (see above)
# 3. Bring the stack up
docker compose -f docker-compose.yaml pull blazar-hydra
docker compose -f docker-compose.yaml down
rm -rf ./persistence/alice ./data-1b          # fresh head (needed after param changes)
docker compose -f docker-compose.yaml up -d

# 4. Wait for cardano-node to sync, then drive the API
docker exec cardano-node cardano-cli query tip --testnet-magic 1 --socket-path /ipc/node.socket
docker logs hydra-node-1 --since 2m 2>&1 | grep -iE "drift|NodeSynced"   # drift should be single-digit seconds
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `RejectedInputBecauseUnsynced` (Init/Close fail) | node drift > CP/2 | use local cardano-node; raise contestation-period |
| Deposits never reach `CommitRecorded`; deposit tx 404 on Blockfrost | unhealthy/lagging chain backend | use local cardano-node |
| `/pay` `ScriptIntegrityHashMismatch` | stale cost models in `protocol-parameters.json` | regenerate cost models, open a fresh head |
| `/pay` or `/withdraw` `TxInvalid: CollateralContainsNonADA` | admin collateral committed with native tokens (admin wallet had no pure-ADA UTxO) | fixed: funding now creates a pure-ADA collateral; open a fresh head |
| Funding stuck in `COMMITTING` for many minutes | normal deposit settlement (`DP … 2·DP` per deposit) | lower `--deposit-period`; wait |
| Close reaches `CLOSING`/`FAILED` (`Timeout waiting for HeadIsFinalized`); node logs `Fanout` `PostTxOnChainFailed: FailedToConstructPartialFanoutTx` + a Blazar-validator `Script evaluation error` | hydra-node 2.2.0 re-runs the Blazar validator on the settled `utxoToDecommit` during partial fanout (see Known limitation below) | **open** — node-side; everything up to and including `Close` works |
| New `/open-head` fails: `Init → CommandFailed`, then commit `400 Head is not open` | a previous head is stuck `Closed`-but-not-finalized (fanout never succeeded) and blocks new heads | wipe the node head state: `docker compose stop hydra-node-1 && rm -rf ./persistence/alice && docker compose up -d hydra-node-1` |
