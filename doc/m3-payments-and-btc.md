# M3: contactless payments (ADA, USDM) and BTC testnet deposits

Public run and integration notes for Milestone 3 of the Catalyst project "USDM and BTC payments
support in Hydra Contactless Micropayments app". Networks: **Bitcoin testnet3** and **Cardano
preprod** only. No mainnet, no real funds. Public API: `https://blazar-api.cardano.vip`
(`GET /health`). Live results are in [section 7](#7-verified-on-preprod-october-2026).

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
| `GET /query-funds?address=` | none | L1 and L2 funds plus `payableInL2` per unit (user funds only; a merchant's received funds are in `totalInL2`); 503 if the head cannot be read |
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
   belongs to another deposit. A txid submitted seconds after broadcast may not be indexed yet
   (422 `BTC_TX_NOT_FOUND`, state unchanged): submit it again a few seconds later.
4. A poller (every `DEPOSIT_POLL_INTERVAL_MS`) follows the bridge status. On `Success` it checks on
   Cardano L1 (Koios) the transaction metadata, the destination and the exact quantity before the
   row becomes `l1_confirmed`. The credited amount is the one measured on L1.
5. The backend spends the bridged UTxO into a user funds UTxO and submits a Hydra incremental
   commit. `available` is set when the commit is finalized in the head (a deposit period of at
   least 300 s). Only then is the BTC payable: `GET /query-funds` shows it in `payableInL2`.
   Before that, the app shows it as pending.
6. Paying with BTC is the normal payment flow with `assetUnit = d2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af425443`.

Measured on preprod: about 24 minutes from BTC broadcast to `available` (about 16 minutes for two
testnet3 confirmations and the bridge, then about 7 minutes for the Hydra commit). Credit happens
at most once: the BTC output `(btcTxid, btcVout)` and the Cardano output
`(redeemTxHash, redeemIndex)` are unique, and nothing is ever credited by hand. A bridge Refund
ends the deposit as `failed`. A deposit in `needs_attention` (bridge Trusteeship, still Processing
after 2 h, memo/value/L1 mismatch, or 3 failed commits) needs the operator to check the bridge
status of the BTC txid.

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

## 7. Verified on preprod (October 2026)

Backend `https://blazar-api.cardano.vip`; `GET /health` reported version
`f4fa9aee3e71ce08afdef2f65f5c928761cbe1fd` (the code of this guide) and a single-party Hydra head
`Open`. One payer and one merchant Firebase test account (provided on request) were seeded with
`POST /accounts`. Times are UTC, 9 to 10 October 2026.

- Payer P: `addr_test1qqv50nl9rp55wt9lvpsshsuu9fxmlqskudg8gmdygpldy6kgtmx9p4gfkl52500g8kcxs7d683w89ne7d5gkgl4yl0jq0ve0zj`
- Merchant M: `addr_test1qqkmdp58hy4urz4zyszpdawfr23fhc3aky27rd7wh0u95h2pvaaxc8qdc6kmpuhz4t5kchxcneya5qtwfes0549pyujqveuc6j`

### Payments (merchant `POST /payments`, terminal `GET /terminal/pending-payment`, payer `authorize`)

| # | Payment | `paymentId` | `hydraTxId` | Snapshot | Result |
|---|---|---|---|---|---|
| 1 | 2 ADA merchant bootstrap | `187e6ec3-4b46-4f89-b915-19d4ab30373c` | `9cfcba4a4f9c63c8de423073f1e740e3cb3c44891a009fda40d3179ee87eb4b4` | 23 | Created 23:41:43, `authorize` HTTP 200 `confirmed` at 23:41:45. The terminal endpoint returned the same `paymentId` with `amountBaseUnits` `"2000000"` (204 when nothing is pending) |
| 2 | 5 ADA, three concurrent `authorize` calls | `75ddd11b-0401-42fb-814e-126cf2e52484` | `be261f72d408fccd69574f8dd474a2becfef1d92c9933db59d7f99a69c26007e` | 24 | All three HTTP 200, one transaction. P `payableInL2` lovelace 99000000 → 94000000 (exactly 5 ADA, once). M `totalInL2` lovelace 7000000 (2 + 5 ADA, no extra ADA) |
| 3 | 10000 BTC units (0.0001 BTC), three concurrent `authorize` calls | `8720bbcf-3252-4c37-8ac1-5b7a3693374e` | `80c0a3d38181fec088814c39020be85719101f4f9f4c265c155d51f21f0180d8` | 26 | One transaction. P BTC 49900 → 39900 (exactly 10000). M `totalInL2` BTC 10000 |

For every payment, `GET /payments/:id` with the payer's token and with the merchant's token returned
the same record (`confirmed`, same `hydraTxId` and snapshot). No live USDM payment is recorded here;
USDM uses the same code path with its own unit.

### BTC deposit through the API (Electrum testnet3)

| Step | Evidence |
|---|---|
| Faucet → test Electrum wallet | BTC tx `7f8fc0588fd04e2bf9630fa3608bbf01af70417ee8a10c51796ee8ef54a3e9c3` (248524 sat), block 5157800 |
| `POST /deposits/btc` (payer) | `depositId` `c5e028f9-2e9b-4845-9c6b-67ef74888672`; `btc.toAccount` `tb1p3l2xzu3lpz68c8ml5qydml44g8vu23q5wjl62cujngyh8xacr5pqyylxef`, `valueSats` 50000; the 68-byte memo was checked locally to encode `DEPOSIT_ADDRESS` |
| BTC tx (Electrum, OP_RETURN checked in the preview) | `63f5b2f2328b58b0d441f508a52623c719097afadcc088bc96bb8a258fe19844`, block 5157802: vout 0 = 50000 sat to the bridge address, vout 2 = `6a44070205…` |
| `POST /deposits/:id/btc-tx` | First call 1 s after broadcast: 422 `BTC_TX_NOT_FOUND` (not indexed yet), state unchanged. Second call: `btc_sent` |
| WanBridge status | `Processing` (receive amount 49900), then `Success` with `redeemHash` `565c077368d1840a495f8d0660d6488629f0d91b1fd64d790d5ec1750cdd9301` |
| Cardano L1 (checked independently on Koios) | Block 5274275, output #0 to `DEPOSIT_ADDRESS`: 49900 × `d2a8592e…425443` + 1.14215 ADA, no datum; metadata `{"1":{"type":9,"uniqueId":"0x63f5b2f2…9844","tokenPairID":517}}` |
| Backend states | `l1_confirmed` 00:42:11 (`l1Ref` `565c0773…#0`, `receivedBaseUnits` 49900) → `committing` 00:42:56 (Hydra deposit tx `7f22a6145a81e0f149bc763881892134c960ee089cefb18db1676a880c7f5042`) → `available` 00:49:48 |
| Payable | P `payableInL2` BTC = 49900 |

End to end: BTC broadcast 00:25:49 → `available` 00:49:48, about **24 minutes** (two testnet3
confirmations and the bridge about 16 minutes, the Hydra commit about 7 minutes).

### BTC deposit from the mobile app (Android emulator, live backend)

| Step | Evidence |
|---|---|
| "Deposit BTC" screen, 0.0003 BTC, "Create deposit" | Same bridge address `tb1p3l2x…ylxef`, 30000 sats, QR code, memo, 30 min expiry |
| BTC tx sent with Electrum from the in-app instructions | `42f38112d7d9e32ac466627cfe7059d5a7fbe08a3f9a7ef6425bf5e32e7b519a` (30000 sat + OP_RETURN), block 5157808 |
| Txid pasted in the app, timeline | BTC sent → Bridge processing → On Cardano (L1): 29940 units after the 0.2% bridge fee, Cardano tx `e0d3abdd7538de058c7c8b6c22ddd56701d2b720aec9077895c87a349f4e84c1#0` → Committing to Hydra: deposit tx `0bada91484275d7c4ef08a56f397a0bfb287d59fbbc96652b59a17b5fc17cf12` → Available (payable) at 01:20 |

The app also showed the payable L2 balance equal to the backend (94.00 ADA), the success screen of
payment 2 read from the backend, and "Payment not confirmed" (backend 404) for a forged
`payment-success` deep link.

### Retries after credit

- A second `POST /deposits/c5e028f9…/btc-tx` with the same txid: the deposit stays `available`, no
  second credit.
- A second `POST /payments/8720bbcf…/authorize`: the same `confirmed` payment, no second debit.
- P `payableInL2` after the retries: BTC 39900, lovelace 94000000 (unchanged).
- Idempotency across a backend restart was not exercised live; it is covered by the automated
  tests (resumable poller, compare-and-set transitions, reconcile at boot).

## 8. Known limitations

- **Testnet and preprod only.** Bitcoin testnet3, Cardano preprod, WanBridge testnet.
- **Custodial demo.** The backend holds the funds and signs with its own key. One client, one
  merchant, one terminal, one head. Not a production custody design.
- **The deployed validator does not enforce the payer signature.** Payer consent is the
  authenticated `authorize` call, checked by the backend, not an on-chain rule.
- **Single shared deposit address.** The bridge memo and destination are the same for all users.
  Attribution is the first claim of a BTC output, so a second app user could claim another user's
  transaction. Acceptable for one client; per-user destinations would close it.
- **Contactless transport: BLE.** The payload is only the `paymentId`, so the transport can change
  without changing the contract.
- **Payable balance = largest funds UTxO per asset.** A payment spends exactly one L2 funds UTxO,
  so `payableInL2` reports, per asset, the largest one, not the sum. Each BTC deposit becomes its
  own funds UTxO: after the two deposits above, payable BTC showed 39900, not 39900 + 29940.
- **No BTC cash-out.** No native BTC withdrawal, no BTC/ADA swap, no Bitcoin wallet in the app.
  About 3 ADA stays locked per BTC deposit.
- The head is not closed in the demo (known Close/Fanout risk). Deposit commits run one at a time.
- Third-party APIs (WanBridge testnet, Koios, mempool.space) can rate-limit; the poller retries
  without backoff.

## 9. Open review items

From the pre-launch code review (fixed: reconcile marking a never-landed payment as confirmed,
stale terminal request causing a double payment, no Hydra WebSocket handshake timeout, and in the
mobile app a success screen that trusted deep-link parameters). Still open:

- The terminal device key has full merchant scope (it can create and supersede payment requests).
- Lazy reconcile on every read can queue behind the global lock while Hydra is unreachable.
- Mobile: a dropped `authorize` response is shown as failure although the payment may confirm;
  the displayed payable balance follows a build-time address, not the signed-in account.
- Funds selection matches snapshot UTxOs by datum only (it does not check validator address and
  control token), so a forged UTxO could make a payment fail (griefing, no theft).
- Malformed JSON returns a framework error page; revoked Firebase users keep access until the
  token expires (at most 1 h); `GET /query-funds` is public by design; `POST /accounts` with an
  empty body returns 400 with an unhelpful issue list (cosmetic).
- Deposits: an unbounded retry when the commit cannot start, and a late-finalizing commit after
  3 attempts leaves the row in `needs_attention` although the funds are payable.
- Hydra amounts are parsed as JS numbers (exact below 2^53); the global lock assumes a single
  backend replica; PR CI lints but does not run the tests.
