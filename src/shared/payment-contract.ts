// payment-contract.ts: shared M3 contract. zod 3.
import { z } from 'zod';

/** Payable assets. Execution moves base units only; `decimals` is for entry/display. */
export const ASSETS = {
  lovelace: { symbol: 'ADA', decimals: 6 },
  // Moneta's official preprod USDM (tUSDM, CIP-68 333 FT); decimals 6 from its CIP-68 reference datum (000643b0…).
  'e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c90014df10745553444d': { symbol: 'USDM', decimals: 6 },
  // WanBridge pair 517 (BTC testnet3 -> preprod): 8 decimals, 1 unit = 1 sat.
  'd2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af425443': { symbol: 'BTC', decimals: 8 },
} as const;
export type AssetUnit = keyof typeof ASSETS;

export const AssetUnitSchema = z.enum(Object.keys(ASSETS) as [AssetUnit, ...AssetUnit[]]);
/** Positive integer in base units as a decimal string: no sign, no leading zeros, < 1e19 (u64). */
export const BaseUnitsSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, 'amount must be a positive integer string in base units');
export const TxIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const OutRefSchema = z.string().regex(/^[0-9a-f]{64}#[0-9]+$/); // "txId#ix"

export const PaymentStateSchema = z.enum([
  'created', 'authorized', 'submitted', 'confirmed', 'failed', 'expired',
]);
export type PaymentState = z.infer<typeof PaymentStateSchema>;
export const TERMINAL_STATES: readonly PaymentState[] = ['confirmed', 'failed', 'expired'];
/** Allowed transitions. The backend applies each one as a compare-and-set on `state`. */
export const NEXT_STATES: Record<PaymentState, readonly PaymentState[]> = {
  created: ['authorized', 'expired'],
  authorized: ['submitted', 'failed'],
  submitted: ['confirmed', 'failed'],
  confirmed: [],
  failed: [],
  expired: [],
};

export const PaymentErrorSchema = z.enum([
  'EXPIRED',
  'NO_L2_FUNDS',
  'INSUFFICIENT_FUNDS',
  'MERCHANT_NOT_BOOTSTRAPPED',
  'TX_INVALID',
  'NOT_SUBMITTED',
  'INTERNAL',
  'STALE_FUNDS', // the funds UTxO the payer signed for was spent or locked meanwhile
]);

/** POST /payments body. Strings only: the backend json-bigint parser turns every JSON number into BigInt. */
export const CreatePaymentSchema = z
  .object({
    merchantAddress: z.string().min(1).optional(), // must equal the calling merchant Account.address; absent: that address
    assetUnit: AssetUnitSchema,
    amountBaseUnits: BaseUnitsSchema,
  })
  .strict();
export type CreatePayment = z.infer<typeof CreatePaymentSchema>;

/** Body of every /payments response. GET /payments/:id is the single source of truth for all UIs. */
export const PaymentSchema = z.object({
  paymentId: z.string().uuid(),
  merchantAddress: z.string(),
  assetUnit: AssetUnitSchema,
  decimals: z.number().int().min(0),
  amountBaseUnits: BaseUnitsSchema,
  state: PaymentStateSchema,
  expiresAt: z.string().datetime(),
  payerAddress: z.string().nullable(), // set at authorize, from the caller's Account
  fundsInRef: OutRefSchema.nullable(), // payer funds UTxO the tx spends
  hydraTxId: TxIdSchema.nullable(), // persisted before NewTx is sent
  snapshotNumber: z.number().int().min(0).nullable(), // SnapshotConfirmed whose `confirmed` holds hydraTxId
  error: PaymentErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Payment = z.infer<typeof PaymentSchema>;

/** BLE GATT layout. Terminal = peripheral "Hydra TERM"; every characteristic is read-only UTF-8. */
export const BLE = {
  DEVICE_NAME: 'Hydra TERM',
  SERVICE_UUID: '1d4ddcb2-279d-42e2-a95a-274352a25248',
  MERCHANT_ADDRESS: 'a781af9a-9a04-4422-9d78-9014497ccdc0', // value1, unchanged
  AMOUNT_BASE_UNITS: '61b64163-35fa-438a-810c-018d1a719667', // value2 = Payment.amountBaseUnits verbatim
  ASSET_UNIT: '52f34145-0363-4f4e-9fab-a133e8e5b0b1', // value3, unchanged
  PAYMENT_ID: '44f2e2a5-f323-44a2-bfbb-4afe3ef2b3ba', // value4, NEW
  // Retired: write characteristic 9b16159d-7c3e-4ae6-990b-0d34f22389bb (payer address). A BLE write never moves money.
} as const;

/**
 * NFC NDEF URI record read by the phone: `myapp://home/nfc?terminal=<merchant Account.id>` (static tag
 * on the terminal -> GET /terminals/:id/pending-payment) or `myapp://home/nfc?paymentId=<uuid>`.
 */
export const NFC = {
  SCHEME: 'myapp',
  PATH: 'home/nfc',
  TERMINAL_PARAM: 'terminal',
  PAYMENT_ID_PARAM: 'paymentId',
} as const;

/** "1.5", 6 -> "1500000". Rejects excess decimals, signs, exponents, zero and out-of-range values. */
export function toBaseUnits(human: string, decimals: number): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(human.trim());
  if (!m) throw new Error('invalid amount');
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimals`);
  const base = (m[1] + frac.padEnd(decimals, '0')).replace(/^0+/, '');
  if (!BaseUnitsSchema.safeParse(base).success) throw new Error('amount must be > 0 and < 1e19 base units');
  return base;
}

/** "1500000", 6 -> "1.5". Display only. */
export function formatBaseUnits(base: string, decimals: number): string {
  const s = base.padStart(decimals + 1, '0');
  const i = s.length - decimals;
  const frac = s.slice(i).replace(/0+$/, '');
  return frac ? `${s.slice(0, i)}.${frac}` : s.slice(0, i);
}

// ---- Deposits (S2 owns the bridge steps, S1 the Hydra commit) ----
export const DepositStateSchema = z.enum([
  'created', // createTx2 done, BTC instructions returned (valid until expiresAt)
  'btc_sent', // btcTxid + vout verified: pays btc.toAccount exactly valueSats with the exact memo
  'bridge_processing', // bridge reports Processing, or Success not yet verified on Cardano L1
  'l1_confirmed', // Koios: unit, quantity, destination, metadata uniqueId = 0x<btcTxid>; in a block
  'committing', // Hydra incremental-commit deposit tx submitted (depositTxId)
  'available', // CommitFinalized for depositTxId: payable in L2
  'failed', // bridge Refund (final)
  'expired', // no BTC tx attached before expiresAt; a tx that still verifies is accepted later
  'needs_attention', // memo/value mismatch, Trusteeship, bridge timeout, L1 mismatch or 3 failed commits
]);
export type DepositState = z.infer<typeof DepositStateSchema>;
export const DepositSchema = z.object({
  depositId: z.string().uuid(),
  userAddress: z.string(),
  assetUnit: AssetUnitSchema,
  state: DepositStateSchema,
  requestedBaseUnits: BaseUnitsSchema, // sats to send
  receivedBaseUnits: BaseUnitsSchema.nullable(), // measured on L1; this is what gets credited
  btc: z.object({ toAccount: z.string(), valueSats: BaseUnitsSchema, memo: z.string() }), // createTx2 at creation
  expiresAt: z.string().datetime(),
  btcTxid: TxIdSchema.nullable(),
  btcVout: z.number().int().min(0).nullable(),
  l1Ref: OutRefSchema.nullable(), // "redeemHash#ix": the bridged UTxO on L1
  fundsTxId: TxIdSchema.nullable(), // L1 tx that moved l1Ref into the user funds UTxO at the validator
  depositTxId: TxIdSchema.nullable(), // Hydra deposit tx committing that funds UTxO
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Deposit = z.infer<typeof DepositSchema>;

/** POST /deposits/btc body. Sats as an integer string, like every amount. */
export const CreateBtcDepositSchema = z.object({ amountSats: BaseUnitsSchema }).strict();
/** POST /deposits/:id/btc-tx body. */
export const AttachBtcTxSchema = z.object({ btcTxid: z.string().toLowerCase().pipe(TxIdSchema) }).strict();

/** PUT /accounts/me/public-key body: the phone's ed25519 public key, raw 32 bytes as lowercase hex. */
export const RegisterPublicKeySchema = z
  .object({ publicKey: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

/** POST /payments/:id/authorize body: the funds UTxO the payer signed for and its ed25519 signature. */
export const AuthorizePaymentSchema = z
  .object({ fundsInRef: OutRefSchema, signature: z.string().max(256) })
  .strict();
