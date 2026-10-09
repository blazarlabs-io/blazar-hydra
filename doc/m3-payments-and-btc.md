# M3: contactless payments (ADA, USDM) and BTC testnet deposits

Public run and integration notes for Milestone 3 of the Catalyst project "USDM and BTC payments
support in Hydra Contactless Micropayments app". Networks: **Bitcoin testnet3** and **Cardano
preprod** only. No mainnet, no real funds. Public API: `https://blazar-api.cardano.vip`
(`GET /health`).

## 1. Architecture

```
Phone app --BLE (read)--> BLE terminal (Raspberry Pi)        Merchant web
   | Firebase ID token       | device key (Bearer)               | Firebase ID token (server proxy)
   | POST /payments/:id/authorize | GET /terminal/pending-payment | POST /payments
   v                          v                                   v
              Custodial backend (this repo, SQLite via Prisma)
                 |                                  |
                 | NewTx / SnapshotConfirmed        | createTx2, status, Koios, mempool
                 v                                  v
            Hydra head (preprod, 1 participant)   WanBridge testnet: BTC testnet3 -> Cardano preprod
```

| Component | Role |
|---|---|
| Phone app | Firebase email/password login, balances (only the Hydra L2 amount is payable), BLE read of the terminal, payer authorization, BTC deposit screen |
| BLE terminal | Fetches the pending payment from the backend and exposes 4 read-only BLE characteristics. It signs nothing |
| Merchant web | The merchant creates a payment request (exact amount, asset) and watches it until it is final |
| Backend (this repo) | Owns payment and deposit state, holds the demo funds in Hydra, executes authorized payments, polls the bridge and commits bridged BTC into the head |
| Hydra head | One head, one participant, Cardano preprod (hydra-node 2.2.0) |
| WanBridge | Testnet bridge: BTC testnet3 with an OP_RETURN memo is minted on preprod as unit `d2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af.425443` (1 sat = 1 unit, 8 decimals) |

Amounts are integer strings in base units end to end (ADA 6, USDM 6, BTC 8 decimals).

## 2. Payment contract

The backend owns the payment. Success means a `SnapshotConfirmed` that contains the transaction.
BLE only carries the `paymentId`; a BLE read never moves money.

```
created -authorize (before expiresAt)-> authorized -hydraTxId persisted, NewTx sent-> submitted -SnapshotConfirmed-> confirmed
   |                                        |                                            |
   +-expired (120 s)                        +-> failed (NO_L2_FUNDS, INSUFFICIENT_FUNDS, +-> failed (TX_INVALID, NOT_SUBMITTED)
                                                 MERCHANT_NOT_BOOTSTRAPPED, INTERNAL)
```

Every transition is a compare-and-set on `state`, so a repeated call is a no-op. A payment never
gets a second transaction: a retry is a new `paymentId`. A `submitted` payment older than 60 s is
reconciled against the head snapshot (on read, on the next authorize of the same payer, and at boot).

### Endpoints

| Method and path | Auth | Notes |
|---|---|---|
| `GET /health` | none | `{status, version, hydra}` |
| `POST /accounts` | admin key | Seed an account: `{kind: user\|merchant, address, firebaseUid?, apiKey?}` |
| `POST /payments` | merchant | `{merchantAddress, assetUnit, amountBaseUnits}`; 201; expires in 120 s; supersedes the merchant's other unpaid requests |
| `GET /terminal/pending-payment` | merchant (device key) | Oldest unexpired `created` payment, or 204 |
| `GET /payments/:id` | any account | A merchant sees its own; a user sees unclaimed ones and its own |
| `POST /payments/:id/authorize` | user | 200 in a final state, 202 if still `submitted` (keep polling); 409 another payer, 410 expired |
| `GET /query-funds?address=` | none | L1 and L2 funds plus `payableInL2` per unit; 503 if the head cannot be read |
| `POST /deposits/btc`, `POST /deposits/:id/btc-tx`, `GET /deposits/:id` | user | BTC deposit (section 3) |
| `/deposit`, `/withdraw`, `/pay-merchant`, `/open-head`, `/close-head`, `/incremental-commit`, `/incremental-decommit` | admin key | Operator routes |

### Auth model

All new routes use `Authorization: Bearer <token>`.

- **Users and merchants:** a Firebase ID token, verified against Google's public JWKS (RS256,
  `aud` and `iss` pinned to `FIREBASE_PROJECT_ID`, `exp`/`iat` checked). The Firebase uid maps to
  an account only through admin seeding. The mobile app and merchant web must use the same
  Firebase project.
- **Terminal:** a device key, stored as a sha256 hash and mapped to the merchant account. It can
  read pending payments but cannot authorize one (403).
- **Admin routes and `POST /accounts`:** `ADMIN_API_KEY` (at least 32 characters, constant-time compare).

### Executor

`authorize` runs under a process-wide lock. It picks one of the payer's L2 funds UTxOs that covers
the exact amount (lovelace minus the locked deposit), finds the merchant funds UTxO, builds the
Hydra transaction with exactly the requested asset (no hidden ADA), persists `hydraTxId` and
`fundsInRef`, and only then sends `NewTx`. It waits up to 30 s for the matching
`SnapshotConfirmed`. Clients should use a request timeout of at least 40 s and poll
`GET /payments/:id` on 202.

## 3. BTC deposit flow

BTC is not created in the app. The user sends testnet3 BTC from an external wallet to the bridge,
the bridge mints the asset on preprod, and the backend commits it into the head.

States: `created` -> `btc_sent` -> `bridge_processing` -> `l1_confirmed` -> `committing` ->
`available` (also `failed`, `expired`, `needs_attention`).

1. `POST /deposits/btc` `{"amountSats":"50000"}` (user token). The backend asks the bridge for a
   quote (minimum is currently 32 sats) and calls `createTx2`. The 201 response carries
   `btc.toAccount`, `btc.valueSats` and `btc.memo`. A deposit expires after 30 minutes.
2. In an external testnet3 wallet (for example Electrum started with `--testnet`) send one
   transaction with two outputs: `<btc.toAccount>, <valueSats as BTC>` and
   `script(OP_RETURN <btc.memo>), 0`. The memo output must begin with `6a44070205`. Without the
   memo the bridge cannot attribute the deposit.
3. `POST /deposits/:id/btc-tx` `{"btcTxid":"<txid>"}`. The backend reads the transaction from
   mempool.space testnet3 and verifies the destination, memo and value. Failures are 422 with
   `MEMO_MISSING`, `VALUE_MISMATCH`, `MULTIPLE_OUTPUTS_TO_DEPOSIT_ADDRESS`,
   `NO_OUTPUT_TO_DEPOSIT_ADDRESS` or `BTC_TX_NOT_FOUND`; 409 `BTC_TX_ALREADY_CLAIMED` if the output
   belongs to another deposit.
4. A poller (every `DEPOSIT_POLL_INTERVAL_MS`) follows the bridge status. On `Success` it checks on
   Cardano L1 (Koios) the transaction metadata, the destination and the exact quantity before the
   row becomes `l1_confirmed`. The credited amount is the one measured on L1.
5. The backend spends the bridged UTxO into a user funds UTxO and submits a Hydra incremental
   commit. `available` is set when the commit is finalized in the head (a deposit period of at
   least 300 s). Only then is the BTC payable: `GET /query-funds` shows it in `payableInL2`.
   Before that, the app shows it as pending.
6. Paying with BTC is the normal payment flow with `assetUnit = d2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af425443`.

Expect about 11 minutes after two testnet3 confirmations. Credit happens at most once: the BTC
output `(btcTxid, btcVout)` and the Cardano output `(redeemTxHash, redeemIndex)` are unique, and
nothing is ever credited by hand. A deposit in `needs_attention` (bridge Trusteeship or Refund,
timeout over 2 h, mismatch) needs the operator to check the bridge status of the BTC txid.

Bridge window: the deposit address belongs to a storeman group that rotates monthly. Do not send
shortly before a rotation, and do not reuse a memo older than 30 minutes; request a new deposit.

## 4. Configuration

Names only; set the values in your environment. Existing variables from the README table still
apply (`PORT`, `PROVIDER_PROJECT_ID`, `PROVIDER_URL`, `NETWORK`, `VALIDATOR_REF`, `SEED`,
`HYDRA_KEY`, `ADMIN_NODE_WS_URL`, `ADMIN_NODE_API_URL`, `LOGGER_LEVEL`, `DATABASE_URL`).

| Variable | Required | Purpose |
|---|---|---|
| `FIREBASE_PROJECT_ID` | yes | Firebase project whose ID tokens are accepted |
| `ADMIN_API_KEY` | yes (32+ chars) | Admin routes and account seeding |
| `DEPOSIT_KEY` | yes | 24-word mnemonic (same format as `SEED`) controlling the bridge destination address. Generate with `npm run deposit-key -- <file>`; keep it out of git and logs |
| `DEPOSIT_ADDRESS` | yes | Base address derived from `DEPOSIT_KEY`; the process refuses to start on a mismatch |
| `DEPOSIT_POLL_INTERVAL_MS` | no | Poller interval (default 60000) |
| `BRIDGE_PLACEHOLDER_FROM` | no | `fromAccount` sent to `createTx2` (the bridge only echoes it) |
| `WANBRIDGE_API_URL`, `KOIOS_URL`, `MEMPOOL_URL` | no | Defaults: WanBridge testnet (mainnet is refused), Koios preprod, mempool.space testnet3 |
| `BUILD_SHA` | no | Build argument reported by `/health` |

## 5. Run locally and test

```bash
cd src
npm ci && npx prisma generate
cp .env.template .env      # fill in the variables above
npm run dev
```

Tests need no `.env`, no node and no network (dummy env, throwaway SQLite database, fake Hydra
and bridge):

```bash
cd src
npm test && npx tsc --noEmit && npx eslint . && npm run build
```

Build a linux/arm64 image and push it under an immutable tag:

```bash
SHA=$(git rev-parse --short HEAD)
docker buildx build --platform linux/arm64 --build-arg BUILD_SHA=$SHA \
  -t <registry>/<image>:m3-$SHA --push .
```

The schema change over the baseline is additive (`Account`, `Payment`, `Deposit`); the image
applies it with `prisma db push`. Back up the SQLite volume before the first deploy.

## 6. Seeding accounts and the 2 ADA merchant bootstrap

Placeholders: `$API` (backend URL), `$ADMIN` (= `ADMIN_API_KEY`). Addresses are preprod base
addresses. Do this once per head, after the tables exist.

```bash
TERMINAL_KEY=$(openssl rand -hex 32)     # device key for the terminal; keep it in the terminal's env only

# merchant: its Firebase uid (merchant web login) and the terminal key share one address
curl -sX POST $API/accounts -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"kind":"merchant","address":"<merchant_addr>","firebaseUid":"<merchant-firebase-uid>","apiKey":"'$TERMINAL_KEY'"}'

# payer: the app user's Firebase uid and the address whose L2 funds it may spend
curl -sX POST $API/accounts -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"kind":"user","address":"<user_addr>","firebaseUid":"<user-firebase-uid>"}'

# fund the payer in L2 (admin route), then check payableInL2
curl -sX POST $API/incremental-commit -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"user_address":"<user_addr>","amount":[["lovelace",20000000],["<usdm_unit>",50000000]]}'
curl -s "$API/query-funds?address=<user_addr>"

# merchant bootstrap: the first payment to a merchant in a head must be at least 2 ADA
curl -sX POST $API/payments -H "authorization: Bearer $TERMINAL_KEY" -H 'content-type: application/json' \
  -d '{"merchantAddress":"<merchant_addr>","assetUnit":"lovelace","amountBaseUnits":"2000000"}'
# the payer authorizes it (from the app, or with a user bearer token):
curl -sX POST $API/payments/<paymentId>/authorize -H "authorization: Bearer <user_token>"
```

The bootstrap creates the merchant funds UTxO in L2. Before it, other payments fail with
`MERCHANT_NOT_BOOTSTRAPPED`. After it, ADA, USDM and BTC payments of any size work.

## 7. Known limitations

- **Testnet and preprod only.** Bitcoin testnet3, Cardano preprod, WanBridge testnet.
- **Custodial demo.** The backend holds the funds and signs with its own key. One client, one
  merchant, one terminal, one head. Not a production custody design.
- **The deployed validator does not enforce the payer signature.** Payer consent is the
  authenticated `authorize` call, checked by the backend, not an on-chain rule.
- **Single shared deposit address.** The bridge memo and destination are the same for all users.
  Attribution is the first claim of a BTC output, so a second app user could claim another user's
  transaction. Acceptable for one client; per-user destinations would close it.
- **BLE transport, not NFC.** The payload is only the `paymentId`, so an NFC transport can be added
  without changing the contract.
- **No BTC cash-out.** No native BTC withdrawal, no BTC/ADA swap, no Bitcoin wallet in the app.
  Each BTC deposit becomes its own L2 funds UTxO (payable separately, not summed), and about
  3 ADA stays locked per deposit.
- The head is not closed in the demo (known Close/Fanout risk). Deposit commits run one at a time.
- Third-party APIs (WanBridge testnet, Koios, mempool.space) can rate-limit; the poller retries
  without backoff.

## 8. Open review items

From the pre-launch code review (fixed: reconcile marking a never-landed payment as confirmed,
stale terminal request causing a double payment, no Hydra WebSocket handshake timeout). Still open:

- The terminal device key has full merchant scope (it can create and supersede payment requests).
- Lazy reconcile on every read can queue behind the global lock while Hydra is unreachable.
- Mobile: a dropped `authorize` response is shown as failure although the payment may confirm;
  the displayed payable balance follows a build-time address, not the signed-in account.
- Funds selection matches snapshot UTxOs by datum only (it does not check validator address and
  control token), so a forged UTxO could make a payment fail (griefing, no theft).
- Malformed JSON returns a framework error page; revoked Firebase users keep access until the
  token expires (at most 1 h); `GET /query-funds` is public by design.
- Deposits: an unbounded retry when the commit cannot start, and a late-finalizing commit after
  3 attempts leaves the row in `needs_attention` although the funds are payable.
- Hydra amounts are parsed as JS numbers (exact below 2^53); the global lock assumes a single
  backend replica; PR CI lints but does not run the tests.
