/**
 * WanBridge client for BTC (testnet3) -> Cardano preprod, tokenPair 517. Testnet only.
 *
 * Testnet flow: createTx2 -> user sends BTC with the OP_RETURN memo -> poll status by BTC txid.
 * createTx2 is stateless (no order id); the memo depends only on the Cardano destination.
 *
 * Self-contained on purpose: it does not import ../../config (which needs the full backend env and
 * opens Prisma), so it can be unit-tested and rebased on its own.
 */
import { getAddressDetails } from '@lucid-evolution/lucid';
import { z } from 'zod';

export const TOKEN_PAIR_ID = 517;
/** Bridged BTC on preprod (asset name "BTC"), Lucid unit format (policy + name, no dot). 1 sat = 1 unit. */
export const BTC_POLICY_ID =
  'd2a8592ec9673ac18fea1044885f94518e954ab0cb2b6bb0a328d2af';
export const BTC_ASSET_NAME = '425443';
export const BTC_UNIT = BTC_POLICY_ID + BTC_ASSET_NAME;

const TESTNET_API = 'https://bridge-api.wanchain.org/api/testnet';
/** WanBridge's toToken: hex of the ASCII string "<policy>.<name>". */
const TO_TOKEN =
  '0x' + Buffer.from(`${BTC_POLICY_ID}.${BTC_ASSET_NAME}`).toString('hex');
const BTC_NATIVE_TOKEN = '0x' + '0'.repeat(40);

/** Mainnet is `.../api`, testnet is `.../api/testnet`. */
export function isTestnetApiUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').endsWith('/testnet');
  } catch {
    return false;
  }
}

// ponytail: bridge-local env; S1 moves these three keys into src/config.ts when wiring.
export const bridgeEnv = z
  .object({
    WANBRIDGE_API_URL: z
      .string()
      .default(TESTNET_API)
      .refine(
        isTestnetApiUrl,
        'WANBRIDGE_API_URL must be the WanBridge testnet API (.../api/testnet); mainnet is refused'
      ),
    KOIOS_URL: z.string().url().default('https://preprod.koios.rest/api/v1'),
    MEMPOOL_URL: z.string().url().default('https://mempool.space/testnet/api'),
  })
  .parse(process.env);

// ---------- exact amounts (no floats) ----------

const SATS_PER_BTC = 100_000_000n;

/** 50000n -> "0.0005". createTx2 takes a decimal BTC string. */
export function satsToBtc(sats: bigint): string {
  if (sats < 0n) throw new RangeError(`Negative amount: ${sats}`);
  const frac = (sats % SATS_PER_BTC)
    .toString()
    .padStart(8, '0')
    .replace(/0+$/, '');
  return `${sats / SATS_PER_BTC}${frac ? '.' + frac : ''}`;
}

/** "0.000499" -> 49900n. Rejects anything that is not an exact number of sats. */
export function btcToSats(btc: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(btc);
  if (!m) throw new RangeError(`Not a decimal BTC amount: "${btc}"`);
  const frac = m[2] ?? '';
  if (/[1-9]/.test(frac.slice(8))) {
    throw new RangeError(`BTC amount below 1 sat precision: "${btc}"`);
  }
  return BigInt(m[1]) * SATS_PER_BTC + BigInt(frac.slice(0, 8).padEnd(8, '0'));
}

export const intString = z
  .string()
  .regex(/^\d+$/, 'expected an integer string')
  .transform(BigInt);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex');

/** Lowercase hex without 0x, as the bridge, mempool.space and Koios use it. */
export function normalizeTxid(txid: string): string {
  return hex64.parse(txid.toLowerCase().replace(/^0x/, ''));
}

// ---------- memo ----------

export type DecodedMemo = {
  type: number;
  tokenPairId: number;
  reserved: string;
  addressHex: string;
};

/** Memo layout: 07 | tokenPairID uint16 BE | 8 bytes | raw Cardano address bytes. */
export function decodeMemo(memo: string): DecodedMemo {
  if (!/^([0-9a-f]{2})+$/.test(memo) || memo.length <= 22) {
    throw new Error(`Memo is not lowercase hex of >11 bytes: "${memo}"`);
  }
  return {
    type: parseInt(memo.slice(0, 2), 16),
    tokenPairId: parseInt(memo.slice(2, 6), 16),
    reserved: memo.slice(6, 22),
    addressHex: memo.slice(22),
  };
}

/** Throws unless the memo is a pair-517 cross-chain memo paying exactly `destination`. */
export function verifyMemo(memo: string, destination: string): DecodedMemo {
  const d = decodeMemo(memo);
  const expected = getAddressDetails(destination).address.hex;
  if (d.type !== 7) throw new Error(`Memo type ${d.type}, expected 7`);
  if (d.tokenPairId !== TOKEN_PAIR_ID) {
    throw new Error(
      `Memo tokenPair ${d.tokenPairId}, expected ${TOKEN_PAIR_ID}`
    );
  }
  // ponytail: zero in every memo seen so far; fail closed until we know what non-zero means.
  if (d.reserved !== '0'.repeat(16)) {
    throw new Error(`Memo reserved bytes not zero: ${d.reserved}`);
  }
  if (d.addressHex !== expected) {
    throw new Error(
      `Memo pays ${d.addressHex}, expected ${destination} (${expected})`
    );
  }
  return d;
}

/** Bridge destination: preprod base address with a key payment credential (scripts get an imposed datum). */
export function assertDepositDestination(address: string): void {
  const d = getAddressDetails(address);
  if (
    d.networkId !== 0 ||
    d.type !== 'Base' ||
    d.paymentCredential?.type !== 'Key'
  ) {
    throw new Error(
      `Bridge destination must be a testnet base key address (addr_test1q…): ${address}`
    );
  }
}

// ---------- HTTP ----------

export async function request(
  url: string,
  init?: RequestInit
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${init?.method ?? 'GET'} ${url}: HTTP ${res.status}, non-JSON body: ${text.slice(0, 200)}`
    );
  }
}

const envelope = z.object({
  success: z.boolean(),
  data: z.unknown(),
  error: z.unknown().optional(),
});

function unwrap<T extends z.ZodTypeAny>(json: unknown, data: T): z.output<T> {
  const r = envelope.parse(json);
  if (!r.success) {
    throw new Error(`WanBridge error: ${JSON.stringify(r.error ?? r.data)}`);
  }
  return data.parse(r.data);
}

const api = (path: string) => `${bridgeEnv.WANBRIDGE_API_URL}${path}`;

// ---------- tokenPairs ----------

const tokenPairSchema = z.object({
  tokenPairID: z.string(),
  fromChain: z.object({ chainType: z.string() }),
  toChain: z.object({ chainType: z.string() }),
  fromToken: z.object({ address: z.string(), decimals: z.string() }),
  toToken: z.object({ address: z.string(), decimals: z.string() }),
});
export type TokenPair = z.output<typeof tokenPairSchema>;

/** Finds pair 517 and checks it is still BTC(8) -> ADA(8) minting exactly BTC_UNIT. */
export function parseTokenPair(json: unknown): TokenPair {
  const raw = unwrap(json, z.array(z.record(z.unknown()))).find(
    (p) => String(p.tokenPairID) === String(TOKEN_PAIR_ID)
  );
  if (!raw) throw new Error(`tokenPair ${TOKEN_PAIR_ID} is not listed`);
  const p = tokenPairSchema.parse(raw);
  const ok =
    p.fromChain.chainType === 'BTC' &&
    p.toChain.chainType === 'ADA' &&
    p.fromToken.decimals === '8' &&
    p.toToken.decimals === '8' &&
    p.toToken.address.toLowerCase() === TO_TOKEN;
  if (!ok)
    throw new Error(`tokenPair ${TOKEN_PAIR_ID} changed: ${JSON.stringify(p)}`);
  return p;
}

export const getTokenPair = async () =>
  parseTokenPair(await request(api('/tokenPairs')));

// ---------- quotaAndFee (all limits in sats) ----------

const quotaSchema = z.object({
  minQuota: intString,
  maxQuota: intString,
  networkFee: z.object({ value: z.string(), isPercent: z.boolean() }),
  operationFee: z.object({
    value: z.string(), // fraction when isPercent: "0.002" = 0.2 %
    isPercent: z.boolean(),
    minFeeLimit: intString,
    maxFeeLimit: intString,
  }),
});
export type QuotaAndFee = z.output<typeof quotaSchema>;

export const parseQuotaAndFee = (json: unknown): QuotaAndFee =>
  unwrap(json, quotaSchema);

export const getQuotaAndFee = async () =>
  parseQuotaAndFee(
    await request(
      api(
        `/quotaAndFee?fromChainType=BTC&toChainType=ADA&tokenPairID=${TOKEN_PAIR_ID}&symbol=BTC`
      )
    )
  );

// ---------- createTx2 ----------

const createTx2Schema = z.object({
  tx: z.object({
    toAccount: z
      .string()
      .regex(
        /^tb1[02-9ac-hj-np-z]{8,87}$/,
        'deposit address must be testnet bech32 (tb1…)'
      ),
    value: z.number().int().nonnegative().transform(BigInt),
    memo: z.string(),
  }),
  receiveAmount: z.string().transform(btcToSats),
});

export type CreateTx2Request = {
  /** Required by the API but only echoed back. */
  fromAccount: string;
  /** Cardano destination (backend deposit key address). */
  toAccount: string;
  amountSats: bigint;
};

export type BtcDepositInstructions = {
  /** BTC address of the current storeman group; changes monthly. */
  depositAddress: string;
  valueSats: bigint;
  /** OP_RETURN payload, raw hex without 0x / 6a44. */
  memo: string;
  /** Bridge estimate; credit only what arrives on L1. */
  receiveSats: bigint;
};

export function parseCreateTx2(
  json: unknown,
  req: Pick<CreateTx2Request, 'toAccount' | 'amountSats'>
): BtcDepositInstructions {
  const { tx, receiveAmount } = unwrap(json, createTx2Schema);
  if (tx.value !== req.amountSats) {
    throw new Error(
      `createTx2 value ${tx.value} != requested ${req.amountSats} sats`
    );
  }
  if (receiveAmount > tx.value) {
    throw new Error(
      `createTx2 receiveAmount ${receiveAmount} > value ${tx.value}`
    );
  }
  verifyMemo(tx.memo, req.toAccount);
  return {
    depositAddress: tx.toAccount,
    valueSats: tx.value,
    memo: tx.memo,
    receiveSats: receiveAmount,
  };
}

export async function createTx2(
  req: CreateTx2Request
): Promise<BtcDepositInstructions> {
  assertDepositDestination(req.toAccount);
  const body = {
    fromChain: 'BTC',
    toChain: 'ADA',
    fromAccount: req.fromAccount,
    fromToken: BTC_NATIVE_TOKEN,
    toToken: TO_TOKEN,
    toAccount: req.toAccount,
    amount: satsToBtc(req.amountSats),
  };
  const json = await request(api('/createTx2?fromChain=BTC'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseCreateTx2(json, req);
}

// ---------- status ----------

export type BridgeStatus =
  | { status: 'NotFound' | 'Processing' | 'Trusteeship' | 'Refund' }
  | {
      status: 'Success';
      /** Cardano tx hash that minted the bridged BTC. */
      redeemHash: string;
      sendAmount: bigint;
      receiveAmount: bigint;
    };

const statusData = z.object({
  lockHash: hex64,
  tokenPair: z.coerce.string(),
  status: z.enum([
    'NotFound',
    'Processing',
    'Success',
    'Trusteeship',
    'Refund',
  ]),
  redeemHash: hex64.nullish(),
  sendAmount: intString.nullish(),
  receiveAmount: intString.nullish(),
});

/** Unknown txid is HTTP 200 `{success:false, data:"NotFound"}`. */
export function parseStatus(json: unknown, btcTxid: string): BridgeStatus {
  const txid = normalizeTxid(btcTxid);
  const r = envelope.parse(json);
  if (!r.success && r.data === 'NotFound') return { status: 'NotFound' };
  const d = unwrap(json, statusData);
  if (d.lockHash !== txid)
    throw new Error(`status lockHash ${d.lockHash} != ${txid}`);
  if (d.tokenPair !== String(TOKEN_PAIR_ID)) {
    throw new Error(`status tokenPair ${d.tokenPair} != ${TOKEN_PAIR_ID}`);
  }
  if (d.status !== 'Success') return { status: d.status };
  if (!d.redeemHash || d.sendAmount == null || d.receiveAmount == null) {
    throw new Error(
      `Success without redeemHash/amounts: ${JSON.stringify(json)}`
    );
  }
  return {
    status: 'Success',
    redeemHash: d.redeemHash,
    sendAmount: d.sendAmount,
    receiveAmount: d.receiveAmount,
  };
}

export const getStatus = async (btcTxid: string) =>
  parseStatus(await request(api(`/status/${normalizeTxid(btcTxid)}`)), btcTxid);
