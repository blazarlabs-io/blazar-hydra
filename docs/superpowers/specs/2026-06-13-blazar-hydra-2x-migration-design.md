# Blazar-Hydra → Hydra 2.2.0 Migration — Design

- **Date:** 2026-06-13
- **Status:** Approved (brainstorming), pending implementation plan
- **Approach:** A — Unify funding on a single deposit/commit path
- **Scope:** Blazar client (TypeScript) **+** infra (cardano-node / hydra-node / docker-compose)

---

## 1. Context & Problem

Cardano **Preprod hard-forked to Protocol Version 11** (the "van Rossem" intra-era
Conway hard fork) on **2026-06-10 00:00 UTC** (ratified 2026-06-05). As of today
the fork is live, so the existing stack is already down on two layers:

1. **L1 node:** `cardano-node:latest` (a ~10.x binary, DB last synced ~June 2025)
   cannot cross the PV11 boundary and has stopped following the chain. The first
   node release supporting PV11 is **cardano-node 11.0.1**.
2. **Hydra:** `hydra-node 0.22.0` pins cardano-node 10.1.4 and is not compatible
   with node 11.0.1. The only Hydra releases that pin node 11.0.1 are **2.1.0 /
   2.2.0**. Hydra **2.0.0 "Directly open heads"** is a breaking change to the
   head lifecycle and API that blazar consumes.

There is no minimal-patch path: crossing PV11 forces hydra-node 2.x, which forces
adopting the 2.x API in blazar.

## 2. Scope

**In scope**

- Infra: pin `cardano-node:11.0.1` (+ from-genesis resync), `hydra-node:2.2.0`,
  new preprod reference-script tx-ids, hydra-node flags, SQLite persistence,
  regenerated protocol parameters — across both `docker-compose.yaml` and
  `docker-compose-digitalpcean.yaml` (in the `hydra-setup` repo).
- Blazar client: the `HydraHandler` WS/HTTP client and the head-lifecycle
  handlers (`open-head`, `incremental-commit`, `incremental-decommit`,
  `close-head`) and the `commit-funds` tx-builder.

**Out of scope**

- On-chain changes to the Blazar Plutus validator. Analysis shows none are
  required; this is validated (not modified) during E2E. The only scenario that
  would pull an on-chain change into scope is the E2E gate failing on
  HydraHeadV2 commit-blueprint validation (considered low probability).
- L2 transaction builders (`pay`, `withdraw-*`) — they attach the validator
  script **inline** and are unaffected by the Hydra 2.x changes.

## 3. Background facts (verified against `api.yaml` @ tag 2.2.0)

Version/compatibility:

| Component | Pin |
|---|---|
| cardano-node | `ghcr.io/intersectmbo/cardano-node:11.0.1` |
| hydra-node | `ghcr.io/cardano-scaling/hydra-node:2.2.0` (tested w/ node 11.0.1, cli 11.0.0) |
| preprod hydra-scripts-tx-id (2.2.0) | `2c01bf787fff78ffe96fb0722e7a9549565ac25d11a76ffb07fd6e809ea00b03,395ecc511b7f05485165da08646ae3224ae0e3905a795bcee408a28eaf4696dd` |

Breaking API changes 0.22.0 → 2.2.0 relevant to blazar:

- **Directly open heads** (2.0.0): no commit phase. `Init` opens the head
  **directly and empty**; funds are added afterward via incremental
  deposits/commits.
- **Removed** ClientInput `Abort` and ServerOutputs `HeadIsInitializing`,
  `HeadIsAborted`, `Committed`. (`Init`, `Close`, `Fanout`, `NewTx`, `Decommit`
  remain.)
- **Deposit/commit lifecycle** ServerOutputs: `CommitRecorded` (carries
  `deadline`) → `CommitApproved` → `CommitFinalized` (terminal; carries
  `depositTxId`). Plus `CommitRecovered`, `DepositExpired`.
- `POST /commit` still accepts the `{blueprintTx, utxo}` payload
  (`FullCommitRequest`), but now **returns a draft deposit transaction** to sign
  and submit to L1. Script-locked commits via blueprint remain supported.
- `POST /decommit`, `GET /snapshot/utxo` unchanged (path + shape).
- Transaction TextEnvelope `type` enum is Conway-only (`Tx ConwayEra`);
  `Tx BabbageEra` removed from the enum (node ignores the label and decodes as
  Conway regardless — so this is spec-conformance, not a hard blocker).
- `HeadIsFinalized.utxo` → `finalizedUTxO` (array of TxOut). Partial fanout added.
- Persistence moved to SQLite `hydra.db` (2.1.0) — operational only.

Key invariant that **does not change**: Blazar's custody model (user funds locked
at the Blazar validator on L1 with a `FundsDatum`) and its L2 transactions
(`pay-merchant`, `withdraw`) are unaffected — L2 txs attach the validator script
**inline** (`setPlutusScripts`), so the "reference scripts on deposited UTxOs are
dropped in L2" caveat does not break them.

## 4. Architecture (Approach A)

```
Infra (docker-compose)                Blazar client (TypeScript)
─────────────────────────             ──────────────────────────────
cardano-node 11.0.1 + resync     →    HydraHandler (refactored):
hydra-node 2.2.0 + new tx-ids          • waitFor(tag) — filtered, terminal-aware, timeout
--incremental-ops (verify)             • commit() — CommitRecorded→Approved→Finalized
--deposit-period sized                 • recover() — DELETE /commits/{tx-id}
hydra.db persisted                     • no abort(); init() waits HeadIsOpen
                                       • envelope type 'Tx ConwayEra'

                                      Unified funding (one path):
                                       Init → HeadIsOpen (empty)
                                       → deposit at Blazar validator (L1)
                                       → POST /commit blueprint
                                         (PartialCommit, VALIDATOR_REF ref-input)
                                       → CommitFinalized
                                      L2 (pay/withdraw): unchanged (script inline)
```

Principle: replace the two brittle commit paths (initial collectCom commit +
incremental commit) with a **single** deposit/commit path, and replace the
fragile `listen()` (which resolves on the first message of any tag) with a
tag-accurate `waitFor`.

## 5. Infra changes (`hydra-setup` repo, both compose files)

1. **cardano-node** → `:11.0.1`. **Wipe the `preprod-node-db` volume** and resync
   from genesis (UTxO-HD / LedgerDB V2 encoding change in 10.7; old snapshots not
   convertible). ~hours on preprod, ~8GB RAM (OnDisk).
2. **hydra-node** → `:2.2.0`; `--hydra-scripts-tx-id` set to the 2.2.0 preprod
   pair above; **add `--incremental-ops`** (verify exact flag against
   `hydra-node 2.2.0 --help`); keep `--deposit-period` (sized so deposit
   confirmation + peer agreement complete within `now+DP .. now+3·DP`) and
   `--contestation-period`.
3. **Persistence**: `--persistence-dir` now holds `hydra.db`; the `./persistence`
   volume already persists it, but **clear `./persistence/*` before first 2.2.0
   start** (the old head was HydraHeadV1).
4. **protocol-parameters.json**: regenerate from the resynced node
   (`cardano-cli query protocol-parameters`), zero out fees/exec-unit prices for
   L2; `protocolVersion` becomes major 11.
5. **blazar-hydra** image: rebuild after code changes; new tag.

Startup order: node 11.0.1 (full resync) → regenerate protocol-params →
hydra-node 2.2.0 (clean persistence) → blazar rebuild.

## 6. Client redesign — `src/offchain/lib/hydra.ts`

New core primitive **`waitFor(tag, opts)`** replacing both `listen()` and
`waitForMessage()`:

- filters strictly on `tag`, logs and ignores non-matching messages;
- resolves on the target tag; rejects on configurable terminal/error tags
  (`DepositExpired`, `DecommitInvalid`, `CommandFailed`, `PostTxOnChainFailed`, …);
- configurable timeout. All `while(tag!==X) listen(X)` loops become `await waitFor(X)`.

| Method | Change |
|---|---|
| `init()` | Send `Init`, wait **`HeadIsOpen`** (not `HeadIsInitializing`). Handle `CommandFailed` (Init on an open head = no-op). |
| `abort()` | **Removed.** |
| `commit(apiUrl, utxos, blueprint)` | Unifies `sendCommit` + confirmation: `POST /commit` → sign returned draft deposit tx → submit L1 → `await waitFor('CommitFinalized')` (correlate on `depositTxId`); `DepositExpired`/`CommitRecovered` terminal. |
| `recover(apiUrl, depositTxId)` | **New:** `DELETE /commits/{tx-id}` → `await waitFor('CommitRecovered')`. |
| `sendTx(tx)` | Envelope `type` → `'Tx ConwayEra'`; `await waitFor('TxValid')`. |
| `decommit(apiUrl, tx)` | Envelope `type` → `'Tx ConwayEra'`; confirmation `DecommitFinalized`/`DecommitInvalid` unchanged. |
| `close()` | Unchanged (`Close` → `HeadIsClosed`). |
| `fanout()` | `Fanout` → wait the **final** `HeadIsFinalized` (partial-fanout aware). |
| `getSnapshot()` | Unchanged (`GET /snapshot/utxo`); optionally handle 404. |

`lucidUtxoToHydraUtxo` / `hydraUtxoToLucidUtxo` / `setRedeemersAsMap` stay; verify
`scriptLanguage` / `PlutusScriptV3` against live 2.2.0 responses during E2E.

## 7. Open-head + funding flow & per-file change map

New flow:

```
handleOpenHead:  Init → waitFor('HeadIsOpen')  [empty head]  → create head in DB
                 (no abort fallback; on failure: Close→Fanout the empty head)

fundOpenHead:    look up Blazar-validator deposit UTxOs on L1 → merge by datum
(was              → for each batch: blueprint (PartialCommit, VALIDATOR_REF ref-input)
 finalizeOpenHead)  → hydra.commit() → CommitFinalized
                 (on failure: hydra.recover(depositTxId) and/or Close)

incrementalCommit: identical to one batch of fundOpenHead → shares helper
```

Extract a shared `commitFundsToHead(hydra, utxos, …)` used by both `fundOpenHead`
and `handleIncrementalCommit`.

**To confirm in E2E:** the per-peer `commitUtxos` split was a collectCom artifact
(each party committed). In 2.x the admin deposits and peers approve via snapshot,
so per-peer splitting collapses to a batching loop on the admin node. Irrelevant
for the single-node DigitalOcean setup.

| File | Change | Sev. |
|---|---|---|
| `offchain/lib/hydra.ts` | Client refactor (§6) | 🔴 |
| `offchain/handlers/open-head.ts` | `handleOpenHead`: Init→HeadIsOpen, no abort. `finalizeOpenHead`→`fundOpenHead` via shared helper. Remove per-peer `commitUtxos`. | 🔴 |
| `offchain/tx-builders/commit-funds.ts` | Always `PartialCommit`/`CombinedPartialCommit`; `VALIDATOR_REF` always reference-input; drop `includeRefScript`/`useRefInput`/`isIncrementalCommit` branches + dead `Commit`/`CombinedCommit` path + inline-script fallback. | 🟡 |
| `offchain/handlers/incremental-commit.ts` | Use `hydra.commit()` (→`CommitFinalized`); drop `includeRefScript:false`. Validator deposit step stays. | 🟡 |
| `offchain/handlers/incremental-decommit.ts` | No change beyond `hydra.decommit` envelope. | 🟢 |
| `offchain/handlers/close-head.ts` | Functionally unchanged; benefits from `waitFor`. | 🟢 |
| `offchain/tx-builders/pay.ts`, `withdraw-*`, L2 builders | **No change.** | 🟢 |

## 8. Error handling & recovery

- **Deposit deadline:** `CommitRecorded.deadline`; if `CommitFinalized` not reached
  → `DepositExpired` → `hydra.recover(depositTxId)` so funds aren't stuck in the
  Hydra deposit on L1.
- **Failed open rollback:** no `Abort`; tear down the empty head via
  `Close → ReadyToFanout → Fanout`.
- **Failed funding:** recover deposited UTxOs, mark head `FAILED` in DB.
- **No infinite loops:** `waitFor` has timeout + terminal tags → failures surface
  as errors (fixes today's hang on `'Committed'` / `'HeadIsInitializing'`).
- **DB states** (`prisma/db-ops.ts` / `DBStatus`): adjust transitions to the new
  flow (`COMMITTING` now covers deposit→CommitFinalized; drop collectCom-specific
  states if any).

## 9. Verification strategy (E2E available on preprod 2.2.0)

1. **Offline gate** (every iteration): `tsc` compile, lint, existing unit tests,
   payload conformance to `api.yaml@2.2.0` (tags, `Tx ConwayEra`, `{blueprintTx,
   utxo}`).
2. **TDD on lifecycle:** write/adapt tests for `waitFor` and `commit()` (mock the
   `CommitRecorded→Approved→Finalized` sequence and `DepositExpired`/timeout)
   before/with implementation. Reuse `offchain/test/demo.ts` and `tests/`.
3. **E2E gate on preprod 2.2.0** (decisive): on the rebuilt docker stack, full
   flow **open → deposit → pay-merchant → withdraw → close/fanout**. Validates the
   residual unknown: the Blazar commit blueprint (`PartialCommit`/
   `CombinedPartialCommit`) against HydraHeadV2. Failure here is the only path that
   pulls an on-chain validator change into scope.
4. **Confirm `--incremental-ops`** against `hydra-node 2.2.0 --help` before E2E.

**Success criterion:** the full E2E flow runs green on preprod 2.2.0, no hangs,
funds correctly settled on L1 after close.

## 10. Risks & open questions

- 🔴→🟡 **HydraHeadV2 commit-blueprint compatibility** — must pass E2E; low
  probability of requiring on-chain change, but it is the migration's risk pivot.
- `--incremental-ops` flag name/existence — single-source claim; confirm against
  the 2.2.0 binary.
- Exact ordering/payloads of `CommitRecorded/Approved/Finalized` — `waitFor` keys
  on `CommitFinalized` (robust to missed intermediates), confirm in E2E.
- Multi-node deposit/approve semantics vs. the old per-peer commit split — confirm
  in E2E (irrelevant for single-node setups).

## 11. References

- Preprod PV11 / van Rossem: cardano-node 11.0.1 release notes; intersectmbo.org
  van Rossem upgrade docs; proposalexaminer gov action.
- Hydra: `cardano-scaling/hydra` releases 2.0.0 / 2.1.0 / 2.2.0; CHANGELOG;
  `hydra-node/json-schemas/api.yaml` @ tag 2.2.0; `networks.json`; hydra.family
  how-to (incremental-commit, commit-blueprint, commit-script-utxo).
