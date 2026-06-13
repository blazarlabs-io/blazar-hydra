# blazar-hydra

Backend for the **Blazar** payment protocol. Users deposit funds on Cardano L1, pay merchants
**off-chain inside a Hydra head (L2)** — fast and feeless — and settle back to L1 at any time.

Runs on **Hydra 2.x** (`hydra-node 2.2.0`) against Cardano **Protocol Version 11 (PV11)**,
backed by a local **`cardano-node 11.0.1`**.

> **New here?** Read [`doc/hydra-2x-migration.md`](./doc/hydra-2x-migration.md) for the
> architecture, the Hydra 2.x funding model, and the (critical) protocol-parameter setup.

## How it works

```
              deposit (L1)            open-head + fund (L1→L2)         pay (L2, off-chain)         withdraw / close (L2→L1)
  user ──────────────────────▶ Blazar validator ──────────▶ Hydra head ──────────────▶ merchant ──────────────▶ L1
```

- **Deposit** — users lock funds at the Blazar validator on L1 (one UTxO per user, by datum).
- **Open head & fund** — the admin opens an empty Hydra head (`Init`) and adds the deposits
  as **incremental commits**, plus a pure-ADA admin collateral UTxO. The head becomes `RUNNING`.
- **Pay** — users pay merchants with feeless, instant transactions **inside the head**.
- **Settle** — users and merchants withdraw to L1 via **decommit** at any time; closing the
  head fans every remaining UTxO out to L1.

The on-chain validator (Aiken, PlutusV3) enforces the rules; this server builds the
transactions and drives the head.

## Architecture

```
┌──────────────┐  socket   ┌──────────────┐  ws/http  ┌──────────────┐  https  ┌───────┐
│ cardano-node  │◀─────────▶│ hydra-node-1 │◀─────────▶│ blazar-hydra  │◀───────▶│ caddy │
│   11.0.1      │node.socket│    2.2.0     │  :4001    │  (this API)   │         │ (TLS) │
└──────────────┘           └──────────────┘           └──────────────┘         └───────┘
        ▲                                                     │
        └────────────────────── L1 (preprod) ◀── Blockfrost (Lucid) ─┘
```

The hydra-node follows L1 through the **local cardano-node socket** (`--node-socket`), **not**
hydra-node Blockfrost mode — on the free Blockfrost tier the node drifts and rejects
operations as `unsynced`. This server still uses Blockfrost (via Lucid) to build its own L1
transactions. See the [migration doc](./doc/hydra-2x-migration.md#do-not-use-hydra-node-blockfrost-mode).

## Documentation

| Doc | Contents |
|---|---|
| [`doc/hydra-2x-migration.md`](./doc/hydra-2x-migration.md) | Architecture, 2.x funding model, **cost-model / protocol-parameter setup**, node config, runbook, troubleshooting |
| [`doc/api-integration.md`](./doc/api-integration.md) | Full API reference (request/response schemas, integration notes) |
| [`doc/requirements_and_design.md`](./doc/requirements_and_design.md) | Problem, design, use cases, on-chain validator details |
| [`doc/INCREMENTAL_FEATURES_COMPLETE_GUIDE.md`](./doc/INCREMENTAL_FEATURES_COMPLETE_GUIDE.md) | Incremental commit / decommit walkthrough |

## Repository layout

```
src/
  api/                 Express app, routes, request/response schemas
  offchain/
    handlers/          One handler per endpoint (deposit, open-head, pay-merchant, …)
    tx-builders/       Transaction builders (deposit, commit-funds, pay, withdraw, merge)
    lib/               HydraHandler (WS/HTTP client), types, transaction helpers
  onchain/hydra-pay/   Aiken validator (PlutusV3) and its types/checks
  prisma/              SQLite schema + DB ops (head/process state)
doc/                   Documentation (see table above)
docker-compose.yaml    Deployment stack (cardano-node + hydra-node + this API + caddy)
Dockerfile             Build for the blazar-hydra image
```

## Run with Docker

[`docker-compose.yaml`](./docker-compose.yaml) brings up the full stack (cardano-node,
hydra-node, this API, caddy). It expects these **deployment-specific files** alongside it
(not committed):

- `.env` — see [Configuration](#configuration)
- `protocol-parameters.json` — L2 ledger params with **current preprod cost models** (see below)
- `credentials/` — the hydra/cardano signing keys
- `Caddyfile` — reverse-proxy config

```bash
docker compose pull blazar-hydra        # or build locally: docker compose build
docker compose up -d
# wait for cardano-node to sync, then the API is reachable through caddy
docker exec cardano-node cardano-cli query tip --testnet-magic 1 --socket-path /ipc/node.socket
```

See the [operational runbook](./doc/hydra-2x-migration.md#operational-runbook) for the full
deploy/redeploy procedure.

## Local development

```bash
cd src
npm install
cp .env.template .env    # then fill it in (see Configuration)
npm run dev              # tsx watch ./api/index.ts
```

Other scripts (run from `src/`):

| Command | Description |
|---|---|
| `npm run build` | Type-check / compile (`tsc`) |
| `npm test` | Run the test suite (`vitest`) |
| `npm run lint` | Lint (`eslint`) — `npm run lint:fix` to autofix |
| `npm run format` | Format with Prettier |
| `npm run deploy` | Deploy the Blazar validator (sets `VALIDATOR_REF`) |
| `npm run demo` | End-to-end demo script |

## Configuration

Environment variables (`src/.env.template`):

| Variable | Description |
|---|---|
| `PORT` | Port this API listens on |
| `PROVIDER_PROJECT_ID` | Blockfrost project id (used by Lucid to build/submit L1 transactions) |
| `PROVIDER_URL` | Blockfrost API URL |
| `NETWORK` | `Mainnet` \| `Preprod` |
| `VALIDATOR_REF` | Tx hash that deployed the Blazar validator (its reference script) |
| `SEED` | 24-word mnemonic of the **Admin** wallet (signs head-management transactions) |
| `HYDRA_KEY` | Script hash of the Hydra Initial validator (a parameter of the Blazar validator) |
| `ADMIN_NODE_WS_URL` | hydra-node WebSocket URL (e.g. `ws://hydra-node-1:4001`) |
| `ADMIN_NODE_API_URL` | hydra-node HTTP API URL (e.g. `http://hydra-node-1:4001`) |
| `LOGGER_LEVEL` | `debug` \| `info` |
| `DATABASE_URL` | SQLite URL (can point to a local file) |

> The demo scripts require additional optional variables that are not needed to run the server.

### Protocol parameters / cost models (important)

The hydra-node validates L2 transactions against `protocol-parameters.json`. Its **cost models
must match the current network (preprod PV11)**, or every script transaction is rejected with
`ScriptIntegrityHashMismatch`. They are baked into a head at `Init`, so regenerate them and
open a **fresh** head when the network's cost models change — see
[the migration doc](./doc/hydra-2x-migration.md#l2-protocol-parameters-cost-models--critical).

## API endpoints

Full schemas and integration notes in [`doc/api-integration.md`](./doc/api-integration.md).

| Method & path | Purpose |
|---|---|
| `POST /deposit` | Lock user funds at the Blazar validator on L1 |
| `POST /open-head` | Open an (empty) head and fund it from deposits; returns `{operationId}` |
| `GET /state?id=` | Head/funding status (`INITIALIZING → MERGING → COMMITTING → RUNNING`, …) |
| `GET /query-funds?address=` | A user's/merchant's funds on L1 and L2 |
| `POST /pay-merchant` | Pay a merchant off-chain inside the head (L2) |
| `POST /incremental-commit` | Add funds to a running head |
| `POST /withdraw` | Settle funds L2→L1 via decommit |
| `POST /incremental-decommit` | Decommit a single funds UTxO L2→L1 |
| `POST /close-head?id=` | Close the head and fan out all UTxOs to L1 |

## Tech stack

- **Off-chain / backend:** TypeScript, [Lucid Evolution](https://github.com/Anastasia-Labs/lucid-evolution),
  Express, `ws`, Axios, Prisma + SQLite, Zod; tested with Vitest.
- **On-chain:** Aiken (PlutusV3) validator.
- **Infra:** cardano-node `11.0.1`, hydra-node `2.2.0`, Caddy.
