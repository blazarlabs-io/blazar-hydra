# Blazar-Hydra → Hydra 2.2.0 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the blazar-hydra TypeScript service from the Hydra 0.22.0 API to Hydra 2.2.0 ("directly open heads"), and bring its docker stack onto cardano-node 11.0.1 / hydra-node 2.2.0 so it works on Preprod after the PV11 hard fork.

**Architecture:** Approach A — collapse the two old commit paths (initial collectCom commit + incremental commit) into a single deposit/commit path. Replace the fragile `listen()` (resolves on the first message of any tag) with a tag-accurate `waitForTag`. Init opens an empty head; funds are added via `/commit` deposits whose terminal success signal is `CommitFinalized`.

**Tech Stack:** TypeScript (ESM, `"type":"module"`), Lucid Evolution, `ws`, `axios`, Prisma/SQLite. Tests added with **vitest** (no test runner exists today). The npm project root is `src/` — all `npm`/`npx` commands run from `/Users/mg/Projects/CardanoProjects/blazar-hydra/src`.

**Reference spec:** `docs/superpowers/specs/2026-06-13-blazar-hydra-2x-migration-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/vitest.config.ts` | Test runner config | Create |
| `src/offchain/lib/hydra-messages.ts` | Pure, testable WS message waiter (`waitForTag`, errors) | Create |
| `src/offchain/lib/hydra-messages.test.ts` | Unit tests for the waiter | Create |
| `src/offchain/lib/hydra.ts` | `HydraHandler` client — uses `waitForTag`; `commit()`/`recover()`; `init→HeadIsOpen`; no `abort()`; ConwayEra envelopes | Modify |
| `src/offchain/tx-builders/commit-funds.ts` | Blueprint builder — always PartialCommit + `VALIDATOR_REF` reference input | Modify |
| `src/offchain/handlers/open-head.ts` | Open empty head + fund via shared `commitFundsToHead` | Modify |
| `src/offchain/handlers/incremental-commit.ts` | Top-up via `hydra.commit()` | Modify |
| `src/offchain/handlers/incremental-decommit.ts`, `close-head.ts` | Verify ConwayEra envelope path; no logic change | Verify |
| `hydra-setup/docker-compose.yaml` | node 11.0.1, hydra 2.2.0, tx-ids, flags | Modify (other repo) |

---

## Phase 0 — Environment (hydra-setup repo, verification-based)

> These are config + ops changes in the **`/Users/mg/Projects/CardanoProjects/hydra-pay-loadbalancer/hydra-setup`** repo. They have no unit tests; verification is "the stack comes up and a head opens".

### Task 0.1: Pin versions + flags in both compose files

**Files:**
- Modify: `hydra-setup/docker-compose.yaml`

- [ ] **Step 1: Confirm the `--incremental-ops` flag name against the real binary**

Run:
```bash
docker run --rm ghcr.io/cardano-scaling/hydra-node:2.2.0 --help | grep -iE 'incremental|deposit-period|hydra-scripts-tx-id'
```
Expected: a line documenting incremental commit/decommit support (note the exact flag spelling). If the flag differs from `--incremental-ops`, use the spelling from `--help` in Step 2. If incremental ops are on by default (no flag), skip adding it.

- [ ] **Step 2: Edit `cardano-node` image (both files)**

Change:
```yaml
    image: ghcr.io/intersectmbo/cardano-node:${CARDANO_NODE_VERSION:-latest}
```
to:
```yaml
    image: ghcr.io/intersectmbo/cardano-node:11.0.1
```

- [ ] **Step 3: Edit every `hydra-node` service (both files)**

For each `hydra-node-N` service: set `image: ghcr.io/cardano-scaling/hydra-node:2.2.0`, replace the `--hydra-scripts-tx-id` value with the 2.2.0 preprod pair, and add the incremental-ops flag from Step 1. The command array becomes (alice shown):
```yaml
    image: ghcr.io/cardano-scaling/hydra-node:2.2.0
    command:
      [
        "--node-id", "1",
        "--api-host", "0.0.0.0",
        "--listen", "0.0.0.0:5001",
        "--monitoring-port", "6001",
        "--api-port", "4001",
        "--hydra-scripts-tx-id",
        "2c01bf787fff78ffe96fb0722e7a9549565ac25d11a76ffb07fd6e809ea00b03,395ecc511b7f05485165da08646ae3224ae0e3905a795bcee408a28eaf4696dd",
        "--hydra-signing-key", "/devnet/credentials/alice-hydra.sk",
        "--cardano-signing-key", "/devnet/credentials/alice-node.sk",
        "--ledger-protocol-parameters", "/devnet/protocol-parameters.json",
        "--testnet-magic", "1",
        "--node-socket", "/devnet/node.socket",
        "--persistence-dir", "/devnet/persistence/alice",
        "--contestation-period", "10s",
        "--deposit-period", "1200s",
        "--incremental-ops"
      ]
```

- [ ] **Step 4: Verify both compose files parse**

Run (from `hydra-setup/`):
```bash
docker compose -f docker-compose.yaml config >/dev/null && echo OK
```
Expected: `OK`, no YAML errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/mg/Projects/CardanoProjects/hydra-pay-loadbalancer/hydra-setup add docker-compose.yaml
git -C /Users/mg/Projects/CardanoProjects/hydra-pay-loadbalancer/hydra-setup commit -m "chore: pin node 11.0.1 + hydra-node 2.2.0 for PV11"
```

### Task 0.2: Resync node, regenerate protocol params, bring up the 2.2.0 stack

**Files:** `hydra-setup/protocol-parameters.json`, docker volumes/dirs.

- [ ] **Step 1: Wipe the stale node DB + old head persistence**

Run (from `hydra-setup/`):
```bash
docker compose down
docker volume rm hydra-setup_preprod-node-db || true
rm -rf ./persistence/alice/* ./persistence/bob/* ./persistence/charlie/*
```
Expected: volume removed; persistence dirs emptied. (Volume name prefix may differ; confirm with `docker volume ls | grep preprod-node-db`.)

- [ ] **Step 2: Start only cardano-node and let it resync past PV11**

Run:
```bash
docker compose up -d cardano-node
# poll until synced
docker compose exec cardano-node cardano-cli query tip --testnet-magic 1 --socket-path /ipc/node.socket
```
Expected: eventually `"syncProgress":"100.00"` and an era of `Conway`. Confirm protocol version 11 (the tip/`query protocol-state` reflects PV11). Resync from genesis takes a few hours on preprod.

- [ ] **Step 3: Regenerate `protocol-parameters.json` for the L2 ledger**

Run:
```bash
docker compose exec cardano-node cardano-cli query protocol-parameters \
  --testnet-magic 1 --socket-path /ipc/node.socket > protocol-parameters.json
```
Then set `txFeeFixed`, `txFeePerByte`, and both `executionUnitPrices` fields to `0` (so L2 txs are free), keeping the rest. Verify `protocolVersion.major` is now `11`.

- [ ] **Step 4: Bring up hydra-node and confirm it is healthy on 2.2.0**

Run:
```bash
docker compose up -d hydra-node-1
docker compose logs --tail=50 hydra-node-1
```
Expected: a `Greetings` / `NodeIsLeader` style log, no era-mismatch / unsupported-script errors, API reachable at `http://127.0.0.1:4001`.

- [ ] **Step 5: Commit the regenerated params**

```bash
git -C /Users/mg/Projects/CardanoProjects/hydra-pay-loadbalancer/hydra-setup add protocol-parameters.json
git -C /Users/mg/Projects/CardanoProjects/hydra-pay-loadbalancer/hydra-setup commit -m "chore: regenerate L2 protocol-parameters for PV11"
```

---

## Phase 1 — Test harness + tag-accurate message waiter (TDD)

### Task 1: Add vitest

**Files:**
- Create: `src/vitest.config.ts`
- Modify: `src/package.json`
- Create (temporary): `src/offchain/lib/smoke.test.ts`

- [ ] **Step 1: Install vitest**

Run (from `src/`):
```bash
npm i -D vitest
```
Expected: `vitest` added to devDependencies.

- [ ] **Step 2: Create `src/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Add the test script to `src/package.json`**

Replace the `"test"` line with:
```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 4: Write a smoke test `src/offchain/lib/smoke.test.ts`**

```ts
import { describe, it, expect } from 'vitest';

describe('vitest smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 5: Run it**

Run (from `src/`):
```bash
npm test
```
Expected: `1 passed`.

- [ ] **Step 6: Delete the smoke test and commit**

```bash
rm offchain/lib/smoke.test.ts
git add vitest.config.ts package.json package-lock.json
git commit -m "test: add vitest runner"
```

### Task 2: TDD `waitForTag`

**Files:**
- Create: `src/offchain/lib/hydra-messages.ts`
- Test: `src/offchain/lib/hydra-messages.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/offchain/lib/hydra-messages.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitForTag, HydraTerminalError, MessageConn } from './hydra-messages';

afterEach(() => vi.useRealTimers());

function fakeConn(): MessageConn & { emit: (m: unknown) => void } {
  const conn: any = { onmessage: null };
  conn.emit = (m: unknown) =>
    conn.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  return conn;
}

describe('waitForTag', () => {
  it('resolves on the target tag', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'HeadIsOpen');
    c.emit({ tag: 'HeadIsOpen', headId: 'h1' });
    await expect(p).resolves.toMatchObject({ tag: 'HeadIsOpen', headId: 'h1' });
  });

  it('ignores non-matching tags then resolves', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'CommitFinalized');
    c.emit({ tag: 'CommitRecorded' });
    c.emit({ tag: 'CommitApproved' });
    c.emit({ tag: 'CommitFinalized', depositTxId: 'd1' });
    await expect(p).resolves.toMatchObject({ depositTxId: 'd1' });
  });

  it('honors the match predicate (correlate on depositTxId)', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'CommitFinalized', {
      match: (m) => m.depositTxId === 'mine',
    });
    c.emit({ tag: 'CommitFinalized', depositTxId: 'other' });
    c.emit({ tag: 'CommitFinalized', depositTxId: 'mine' });
    await expect(p).resolves.toMatchObject({ depositTxId: 'mine' });
  });

  it('rejects on a terminal tag', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'CommitFinalized', { terminalTags: ['DepositExpired'] });
    c.emit({ tag: 'DepositExpired', depositTxId: 'd1' });
    await expect(p).rejects.toBeInstanceOf(HydraTerminalError);
  });

  it('ignores non-JSON frames', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'TxValid');
    c.emit('not-json');
    c.emit({ tag: 'TxValid' });
    await expect(p).resolves.toMatchObject({ tag: 'TxValid' });
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const c = fakeConn();
    const p = waitForTag(c, 'HeadIsOpen', { timeout: 1000 });
    const assertion = expect(p).rejects.toThrow(/Timeout/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `src/`):
```bash
npm test -- hydra-messages
```
Expected: FAIL — `Cannot find module './hydra-messages'`.

- [ ] **Step 3: Implement `src/offchain/lib/hydra-messages.ts`**

```ts
import { logger } from '../../shared/logger';

export interface MessageConn {
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface WaitOptions {
  /** ms before the wait rejects with a Timeout error. Default 60_000. */
  timeout?: number;
  /** tags that reject the wait (failure terminals). */
  terminalTags?: string[];
  /** optional extra predicate the matching message must satisfy. */
  match?: (msg: any) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** observe every parsed message (e.g. progress logging). */
  onMessage?: (msg: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class HydraTerminalError extends Error {
  constructor(
    public readonly tag: string,
    public readonly payload: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(`Received terminal tag '${tag}' while waiting`);
    this.name = 'HydraTerminalError';
  }
}

/**
 * Resolve when a Hydra ServerOutput with `tag` (and optional `match`) arrives.
 * Ignores every other message; rejects on a configured terminal tag or timeout.
 * Replaces the legacy listen()/waitForMessage() which resolved on the first
 * message of ANY tag.
 */
export function waitForTag(
  conn: MessageConn,
  tag: string,
  opts: WaitOptions = {}
): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { timeout = 60_000, terminalTags = [], match, onMessage } = opts;
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      conn.onmessage = null;
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`Timeout after ${timeout}ms waiting for tag '${tag}'`));
    }, timeout);

    conn.onmessage = (ev) => {
      let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        data = JSON.parse(raw);
      } catch {
        return; // ignore non-JSON frames
      }
      onMessage?.(data);
      if (data.tag === tag && (!match || match(data))) {
        done();
        resolve(data);
      } else if (terminalTags.includes(data.tag)) {
        done();
        reject(new HydraTerminalError(data.tag, data));
      } else {
        logger.debug(`Ignoring ${data.tag} while waiting for ${tag}`);
      }
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `src/`):
```bash
npm test -- hydra-messages
```
Expected: `6 passed`.

- [ ] **Step 5: Commit**

```bash
git add offchain/lib/hydra-messages.ts offchain/lib/hydra-messages.test.ts
git commit -m "feat: tag-accurate waitForTag with terminal-tag and timeout handling"
```

---

## Phase 2 — Rewire `HydraHandler` (`src/offchain/lib/hydra.ts`)

> Integration code (ws + axios + lucid). Verified by `tsc` + the lifecycle tests above + the Phase 6 E2E gate.

### Task 3: Replace `listen`/`waitForMessage`/`init`/`abort` and fix envelopes

**Files:**
- Modify: `src/offchain/lib/hydra.ts`

- [ ] **Step 1: Import the waiter and drop the bespoke waiters**

At the top of `hydra.ts` add:
```ts
import { waitForTag } from './hydra-messages';
```
Delete the `private waitForMessage(...)` method (lines ~72-92), the `public async listen(...)` method (lines ~100-115), and the `ERROR_TAGS` constant (lines ~15-22) — terminal tags are now passed per-wait via `waitForTag`'s `terminalTags` option.

- [ ] **Step 2: Rewrite `init()` to wait `HeadIsOpen`**

Replace `init()` with:
```ts
/** Sends Init; the head opens directly (empty). Resolves with the HeadIsOpen output. */
async init(): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  await this.ensureConnectionReady();
  logger.debug('Sending Init; awaiting HeadIsOpen...');
  this.connection.send(JSON.stringify({ tag: 'Init' }));
  return waitForTag(this.connection, 'HeadIsOpen', {
    timeout: 120_000,
    terminalTags: ['CommandFailed', 'PostTxOnChainFailed'],
  });
}
```

- [ ] **Step 3: Remove `abort()`**

Delete the entire `async abort()` method (lines ~143-151). (`Abort`/`HeadIsAborted` do not exist in 2.x.)

- [ ] **Step 4: Fix `sendTx` envelope + wait**

In `sendTx`, change the transaction `type` from `'Tx BabbageEra'` to `'Tx ConwayEra'` and replace the trailing `return this.listen('TxValid');` with:
```ts
  return waitForTag(this.connection, 'TxValid', { terminalTags: ['TxInvalid'] });
```

- [ ] **Step 5: Fix `decommit` envelope**

In `decommit`, change `type: 'Tx BabbageEra'` to `type: 'Tx ConwayEra'`. (Confirmation is awaited by the caller via the decommit lifecycle; leave the POST behavior otherwise unchanged.)

- [ ] **Step 6: Update `close()` and `fanout()` to use `waitForTag`**

`close()` body:
```ts
  await this.ensureConnectionReady();
  this.connection.send(JSON.stringify({ tag: 'Close' }));
  const data = await waitForTag(this.connection, 'HeadIsClosed', { timeout: 60_000 });
  return data.tag;
```
`fanout()` body:
```ts
  await this.ensureConnectionReady();
  this.connection.send(JSON.stringify({ tag: 'Fanout' }));
  const data = await waitForTag(this.connection, 'HeadIsFinalized', { timeout: 120_000 });
  return data.tag;
```

- [ ] **Step 7: Verify the file still type-checks**

Run (from `src/`):
```bash
npx tsc --noEmit
```
Expected: no errors referencing `hydra.ts` (callers of `listen`/`abort` will error — they are fixed in Phase 3/4; if you run tsc now expect ONLY those caller errors, which the next tasks remove).

- [ ] **Step 8: Commit**

```bash
git add offchain/lib/hydra.ts
git commit -m "refactor(hydra): waitForTag, init->HeadIsOpen, drop abort, ConwayEra envelopes"
```

### Task 4: Add `HydraHandler.commit()` and `recover()`

**Files:**
- Modify: `src/offchain/lib/hydra.ts`

- [ ] **Step 1: Add a `commit()` that drives the deposit lifecycle**

Replace `sendCommit(...)` with a `commit(...)` that keeps the existing payload-building + sign + submit logic, then awaits `CommitFinalized`. Body:
```ts
/**
 * Draft a deposit/commit tx via POST {apiUrl} (/commit), sign + submit it to L1,
 * then await CommitFinalized for that deposit. Returns the deposit txId.
 */
async commit(
  apiUrl: string,
  utxos: UTxO[],
  blueprint?: CBORHex
): Promise<string> {
  // --- build FullCommitRequest payload (unchanged from sendCommit) ---
  const formatUtxos = (us: UTxO[]) =>
    us.reduce((acc, u) => {
      acc[`${u.txHash}#${u.outputIndex}`] = lucidUtxoToHydraUtxo(u);
      return acc;
    }, {} as Record<string, any>); // eslint-disable-line @typescript-eslint/no-explicit-any

  let payload: { blueprintTx?: any; utxo?: any } = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (utxos.length > 0) {
    if (blueprint) {
      payload['blueprintTx'] = { cborHex: blueprint, description: '', type: 'Tx ConwayEra' };
      payload['utxo'] = formatUtxos(utxos);
    } else {
      payload = formatUtxos(utxos);
    }
  }

  // --- POST /commit -> draft deposit tx ---
  const response = await axios.post(apiUrl, payload);
  const draft = response.data.cborHex;
  this.lucid.selectWallet.fromSeed(env.SEED);
  const signedTx = await this.lucid
    .fromTx(draft)
    .sign.withWallet()
    .complete()
    .then((tx) => setRedeemersAsMap(tx.toCBOR()));
  const depositTxId = await this.lucid.wallet().submitTx(signedTx);
  logger.info(`Deposit tx submitted to L1: ${depositTxId}; awaiting CommitFinalized...`);

  // --- await the deposit lifecycle terminal (funds on L2) ---
  await waitForTag(this.connection, 'CommitFinalized', {
    timeout: 1_300_000, // > deposit-period (1200s) so the deadline can pass
    match: (m) => m.depositTxId === depositTxId,
    terminalTags: ['DepositExpired'],
    onMessage: (m) => {
      if (['CommitRecorded', 'CommitApproved'].includes(m.tag)) {
        logger.debug(`Commit progress: ${m.tag}`);
      }
    },
  });
  return depositTxId;
}

/** Recover an un-finalized deposit (DELETE {apiUrl}/{depositTxId}); awaits CommitRecovered. */
async recover(apiUrl: string, depositTxId: string): Promise<void> {
  await axios.delete(`${apiUrl}/${depositTxId}`);
  await waitForTag(this.connection, 'CommitRecovered', { timeout: 120_000 });
}
```
Keep the existing `catch`/error-logging wrapper from `sendCommit` around the POST/submit section.

- [ ] **Step 2: Verify type-check of the new methods in isolation**

Run (from `src/`):
```bash
npx tsc --noEmit 2>&1 | grep -E 'hydra\.ts' || echo "hydra.ts clean"
```
Expected: `hydra.ts clean` (caller files updated in later tasks).

- [ ] **Step 3: Commit**

```bash
git add offchain/lib/hydra.ts
git commit -m "feat(hydra): commit() drives deposit lifecycle to CommitFinalized; add recover()"
```

---

## Phase 3 — Simplify the commit blueprint (`commit-funds.ts`)

### Task 5: Always PartialCommit + `VALIDATOR_REF` reference input

**Files:**
- Modify: `src/offchain/tx-builders/commit-funds.ts`

- [ ] **Step 1: Simplify `buildIncrementalCommitBlueprint` params and body**

Remove `useRefInput` and `isIncrementalCommit` from `IncrementalCommitBlueprintParams` (keep `adminAddress`, `depositedUtxo`, `validatorRefUtxo`). In the body: always use `Spend.PartialCommit` and `Combined.CombinedPartialCommit`, and always attach the validator as a **reference input** (the `useRefInput:true` branch). Delete the inline-script (`else`) branch entirely. The reference-input block becomes unconditional:
```ts
  // Always reference the on-L1 validator ref-script UTxO (head opens empty in 2.x;
  // VALIDATOR_REF is never consumed into the head).
  const referenceInputs = CML.TransactionInputList.new();
  referenceInputs.add(utxoToCore(validatorRefUtxo).input());
  txBody.set_reference_inputs(referenceInputs);
```
and the redeemers are fixed:
```ts
  const spendRedeemer = Spend.PartialCommit;
  const withdrawRedeemer = Combined.CombinedPartialCommit;
```

- [ ] **Step 2: Remove the now-dead `commitFunds` initial-commit builder**

Delete the `commitFunds(...)` function (the `Spend.Commit` / `Combined.CombinedCommit` variant) and drop it from the `export { ... }` list. It implemented the collectCom initial commit, which no longer exists. Verify no other file imports `commitFunds`:
```bash
grep -rn "commitFunds\b" offchain --include='*.ts' | grep -v buildIncrementalCommitBlueprint
```
Expected: only the (about-to-be-rewritten) `open-head.ts` reference, which Task 6 removes.

- [ ] **Step 3: Type-check**

Run (from `src/`):
```bash
npx tsc --noEmit 2>&1 | grep -E 'commit-funds\.ts' || echo "commit-funds.ts clean"
```
Expected: `commit-funds.ts clean`.

- [ ] **Step 4: Commit**

```bash
git add offchain/tx-builders/commit-funds.ts
git commit -m "refactor(commit-funds): always PartialCommit + ref-input; drop initial-commit builder"
```

---

## Phase 4 — Handlers

### Task 6: Rewrite `open-head.ts` (empty open + shared funding)

**Files:**
- Modify: `src/offchain/handlers/open-head.ts`

- [ ] **Step 1: Rewrite `handleOpenHead` (Init → HeadIsOpen, no abort)**

```ts
async function handleOpenHead(
  lucid: LucidEvolution
): Promise<{ operationId: string }> {
  const { ADMIN_NODE_WS_URL: wsUrl } = env;
  const localLucid = _.cloneDeep(lucid);
  localLucid.selectWallet.fromSeed(env.SEED);
  const hydra = new HydraHandler(localLucid, wsUrl);
  try {
    logger.debug('Opening head (directly open in Hydra 2.x)...');
    await hydra.init(); // resolves on HeadIsOpen (empty head)
    const processId = await DBOps.newHead();
    await hydra.stop();
    return { operationId: processId };
  } catch (error) {
    logger.error('Error while opening head');
    await hydra.stop();
    throw error;
  }
}
```

- [ ] **Step 2: Add the shared `commitFundsToHead` helper**

```ts
/** Deposit one batch of script-locked UTxOs into the OPEN head via /commit blueprint. */
async function commitFundsToHead(
  hydra: HydraHandler,
  lucid: LucidEvolution,
  fundUtxo: UTxO,
  validatorRef: UTxO
): Promise<string> {
  const blueprint = await buildIncrementalCommitBlueprint(lucid, {
    adminAddress: await lucid.wallet().address(),
    depositedUtxo: fundUtxo,
    validatorRefUtxo: validatorRef,
  });
  return hydra.commit(`${env.ADMIN_NODE_API_URL}/commit`, [fundUtxo], blueprint);
}
```

- [ ] **Step 3: Replace `finalizeOpenHead` body with deposit-based funding**

Keep `collectDeposits` and `mergeDeposits` (they prepare the merged UTxOs). Replace the `commitUtxos(...)` call and the `HeadIsOpen` wait loop with a per-batch deposit loop, and drop the per-peer `commitUtxos`/`pickAdminCollateral` machinery:
```ts
async function finalizeOpenHead(
  lucid: LucidEvolution,
  params: ManageHeadSchema,
  processId: string
) {
  const localLucid = _.cloneDeep(lucid);
  localLucid.selectWallet.fromSeed(env.SEED);
  const network = getNetworkFromLucid(localLucid);
  const { VALIDATOR_REF: vRef } = env;
  const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
  try {
    const adminAddress = await localLucid.wallet().address();
    const [validatorRef] = await localLucid.utxosByOutRef([{ txHash: vRef, outputIndex: 0 }]);
    const validator = getValidator(validatorRef);
    const scriptAddress = validatorToAddress(network, validator);
    const scriptUtxos = await localLucid.utxosAt(scriptAddress);

    const depositsByDatum = collectDeposits(scriptUtxos);
    const utxosToCommit = await mergeDeposits(
      processId, localLucid, adminAddress, validatorRef, depositsByDatum
    );

    await DBOps.updateHeadStatus(processId, DBStatus.COMMITTING);
    for (const fundUtxo of utxosToCommit) {
      const depositTxId = await commitFundsToHead(hydra, localLucid, fundUtxo, validatorRef);
      logger.info(`Committed fund UTxO into head (deposit ${depositTxId})`);
    }
    await DBOps.updateHeadStatus(processId, DBStatus.RUNNING);
    await hydra.stop();
  } catch (error) {
    logger.error('Error while funding head');
    await DBOps.updateHeadStatus(processId, DBStatus.FAILED);
    await hydra.stop();
    throw error;
  }
}
```
Delete `commitUtxos`, `pickAdminCollateral`, and the now-unused imports (`commitFunds`, `CommitFundsParams`, `sortUTxOs`, `selectUTxOs` if unused, `MAX_UTXOS_PER_COMMIT`). Keep `submitMergeTxs`/`mergeDeposits`/`collectDeposits`.

- [ ] **Step 4: Type-check**

Run (from `src/`):
```bash
npx tsc --noEmit 2>&1 | grep -E 'open-head\.ts' || echo "open-head.ts clean"
```
Expected: `open-head.ts clean`.

- [ ] **Step 5: Commit**

```bash
git add offchain/handlers/open-head.ts
git commit -m "refactor(open-head): directly-open head + deposit-based funding via shared helper"
```

### Task 7: Update `incremental-commit.ts`

**Files:**
- Modify: `src/offchain/handlers/incremental-commit.ts`

- [ ] **Step 1: Replace the `/commit` + Committed loop with `hydra.commit()`**

Remove the `includeRefScript:false` argument and the `buildIncrementalCommitBlueprint(..., {useRefInput, isIncrementalCommit})` extra flags (the builder no longer takes them). Replace the block from `const hydra = new HydraHandler(...)` through the `while (commitTag !== 'Committed')` loop with:
```ts
  const hydra = new HydraHandler(localLucid, env.ADMIN_NODE_WS_URL);
  try {
    const blueprintTx = await buildIncrementalCommitBlueprint(localLucid, {
      adminAddress,
      depositedUtxo,
      validatorRefUtxo: validatorRef,
    });
    const depositTxId = await hydra.commit(
      `${env.ADMIN_NODE_API_URL}/commit`,
      [depositedUtxo],
      blueprintTx
    );
    logger.info(`Incremental commit finalized for ${userAddress} (deposit ${depositTxId})`);
    await hydra.stop();
    return { cborHex: tx.toCBOR(), fundsUtxoRef: newFundsUtxo };
  } catch (error) {
    logger.error(`Error during incremental commit: ${error}`);
    await hydra.stop();
    throw error;
  }
```

- [ ] **Step 2: Type-check**

Run (from `src/`):
```bash
npx tsc --noEmit 2>&1 | grep -E 'incremental-commit\.ts' || echo "incremental-commit.ts clean"
```
Expected: `incremental-commit.ts clean`.

- [ ] **Step 3: Commit**

```bash
git add offchain/handlers/incremental-commit.ts
git commit -m "refactor(incremental-commit): use hydra.commit() lifecycle; drop ref-script flags"
```

### Task 8: Verify decommit/close + whole-project type-check

**Files:**
- Verify: `src/offchain/handlers/incremental-decommit.ts`, `src/offchain/handlers/close-head.ts`

- [ ] **Step 1: Confirm decommit/close compile against the new client**

These call `hydra.decommit(...)`, `hydra.getSnapshot()`, `hydra.close()`, `hydra.fanout()` — all still present. They previously used `hydra.listen(...)` loops, which no longer exist. Add two encapsulated wait methods to `hydra.ts` (so callers never touch `this.connection` directly):
```ts
/** Await the terminal of a decommit started via decommit(). */
async awaitDecommit(): Promise<void> {
  await waitForTag(this.connection, 'DecommitFinalized', {
    timeout: 120_000,
    terminalTags: ['DecommitInvalid'],
  });
}

/** Await ReadyToFanout after a Close. */
async awaitReadyToFanout(): Promise<void> {
  await waitForTag(this.connection, 'ReadyToFanout', { timeout: 120_000 });
}
```
Then: in `incremental-decommit.ts` and in `close-head.ts`'s `withdrawMerchantUtxos`, replace the `while (decommitTag !== 'DecommitFinalized') { decommitTag = await hydra.listen('DecommitFinalized'); ... }` loop with a single `await hydra.awaitDecommit();`. In `close-head.ts`'s `finalizeCloseHead`, replace the `while (currentExpectedTag !== 'ReadyToFanout') { ... hydra.listen('ReadyToFanout') }` loop with `await hydra.awaitReadyToFanout();`, and the `hydra.close()` retry loop already returns `HeadIsClosed` from the updated `close()` (Task 3 Step 6).

- [ ] **Step 2: Whole-project type-check + lint**

Run (from `src/`):
```bash
npx tsc --noEmit && npm run lint
```
Expected: no type errors; lint clean (fix any unused-import warnings the refactor created).

- [ ] **Step 3: Run the unit tests**

Run (from `src/`):
```bash
npm test
```
Expected: all `hydra-messages` tests pass.

- [ ] **Step 4: Commit**

```bash
git add offchain/handlers/incremental-decommit.ts offchain/handlers/close-head.ts offchain/lib/hydra.ts
git commit -m "refactor(handlers): replace listen() with waitForTag-backed decommit/fanout waits"
```

---

## Phase 5 — End-to-end gate (decisive)

### Task 9: Full flow on preprod 2.2.0

**Files:** none (operational); uses the Phase 0 stack and `offchain/test/demo.ts` (adapt as needed).

- [ ] **Step 1: Rebuild and start the blazar image against the 2.2.0 node**

```bash
docker compose -f /Users/mg/Projects/CardanoProjects/hydra-pay-loadbalancer/hydra-setup/docker-compose.yaml up -d --build blazar-hydra
```
Expected: container healthy, connects to `ws://hydra-node-1:4001`, no startup errors.

- [ ] **Step 2: Run the full lifecycle**

Drive: open head → deposit → incremental-commit → pay-merchant → withdraw (decommit) → close → fanout (via the API routes or an adapted `npm run demo`). Watch hydra-node logs for `HeadIsOpen`, `CommitRecorded`/`CommitApproved`/`CommitFinalized`, `TxValid`, `DecommitFinalized`, `HeadIsClosed`, `ReadyToFanout`, `HeadIsFinalized`.

Expected: every step completes; **the commit step proves the Blazar `PartialCommit` blueprint validates against HydraHeadV2** (the migration's risk pivot). Funds are correctly settled on L1 after fanout.

- [ ] **Step 3: If commit validation fails on-chain**

If `/commit` or the increment is rejected with a script-validation error, capture the hydra-node log and the rejected tx, and open a follow-up: the Blazar validator's `PartialCommit`/`CombinedPartialCommit` path may need adjustment for HydraHeadV2 / PlutusV3 — this is the only scenario that pulls on-chain work into scope (out of scope for this plan).

- [ ] **Step 4: Tag the working image and record the result**

On green, retag the blazar image (e.g. `:hydra2x`) and note the verified flow in the PR description.

---

## Self-Review notes (author)

- **Spec coverage:** infra (§5)→Task 0.x; HydraHandler/waitFor (§6)→Tasks 2-4,8; open-head+funding (§7)→Tasks 6-7; commit-funds (§7)→Task 5; error/recovery (§8)→`recover()`/terminal tags in Tasks 4,8; verification (§9)→Tasks 1-2 (offline/TDD) + Task 9 (E2E). Covered.
- **Type consistency:** `waitForTag(conn, tag, opts)`, `HydraTerminalError`, `MessageConn` used consistently; `hydra.commit()` returns `depositTxId: string`; `buildIncrementalCommitBlueprint` final params = `{adminAddress, depositedUtxo, validatorRefUtxo}` everywhere.
- **Known soft spots flagged in-plan:** exact `--incremental-ops` spelling (Task 0.1 Step 1), CML signatures verified via `tsc` per task, on-chain HydraHeadV2 compatibility gated at Task 9.
