/**
 * Independent on-chain checks for a bridge deposit. Both return typed results and never credit.
 *
 * - Bitcoin side (mempool.space testnet3): which output of the user's tx is the deposit, and does
 *   the tx carry the exact memo.
 * - Cardano side (Koios preprod): the bridge's redeem tx pays `unit` to `destination` and its
 *   metadata label 1 links it to the BTC txid. The Lucid Provider (Blockfrost/Kupmios) used by the
 *   backend cannot read tx metadata, hence Koios.
 */
import { getAddressDetails } from '@lucid-evolution/lucid';
import { z } from 'zod';
import {
  bridgeEnv,
  intString,
  normalizeTxid,
  request,
  TOKEN_PAIR_ID,
} from './client';

export type OutRef = { txHash: string; outputIndex: number };

// ---------- Bitcoin (mempool.space) ----------

const btcTxSchema = z.object({
  txid: z.string(),
  status: z.object({ confirmed: z.boolean() }),
  vout: z.array(
    z.object({
      scriptpubkey: z.string(),
      scriptpubkey_address: z.string().nullish(),
      value: z.number().int().nonnegative(),
    })
  ),
});
export type BtcTx = z.output<typeof btcTxSchema>;

export const parseBtcTx = (json: unknown): BtcTx => btcTxSchema.parse(json);

export const fetchBtcTx = async (txid: string): Promise<BtcTx> =>
  parseBtcTx(
    await request(`${bridgeEnv.MEMPOOL_URL}/tx/${normalizeTxid(txid)}`)
  );

export type BtcDepositCheck =
  | { ok: true; vout: number; valueSats: bigint; confirmed: boolean }
  | {
      ok: false;
      reason:
        | 'NO_OUTPUT_TO_DEPOSIT_ADDRESS'
        | 'MULTIPLE_OUTPUTS_TO_DEPOSIT_ADDRESS'
        | 'MEMO_MISSING';
    };

export function findBtcDeposit(
  tx: BtcTx,
  expected: { depositAddress: string; memo: string }
): BtcDepositCheck {
  const paying = tx.vout.flatMap((o, i) =>
    o.scriptpubkey_address === expected.depositAddress ? [i] : []
  );
  if (paying.length === 0)
    return { ok: false, reason: 'NO_OUTPUT_TO_DEPOSIT_ADDRESS' };
  if (paying.length > 1) {
    return { ok: false, reason: 'MULTIPLE_OUTPUTS_TO_DEPOSIT_ADDRESS' };
  }
  // OP_RETURN + one direct push (memo is at most 68 bytes, so the push opcode is the length).
  const pushLen = (expected.memo.length / 2).toString(16).padStart(2, '0');
  const script = `6a${pushLen}${expected.memo}`;
  if (!tx.vout.some((o) => o.scriptpubkey === script)) {
    return { ok: false, reason: 'MEMO_MISSING' };
  }
  const vout = paying[0];
  return {
    ok: true,
    vout,
    valueSats: BigInt(tx.vout[vout].value),
    confirmed: tx.status.confirmed,
  };
}

// ---------- Cardano (Koios) ----------

const koiosTxSchema = z.object({
  tx_hash: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  outputs: z.array(
    z.object({
      tx_index: z.number().int().nonnegative(),
      payment_addr: z.object({ bech32: z.string() }),
      value: intString,
      asset_list: z
        .array(
          z.object({
            policy_id: z.string(),
            asset_name: z.string().nullable(),
            quantity: intString,
          })
        )
        .nullable(),
    })
  ),
});
export type KoiosTx = z.output<typeof koiosTxSchema>;

/** Koios tx_info returns an array; [] when the tx is unknown. */
export const parseKoiosTx = (json: unknown): KoiosTx | undefined =>
  z.array(koiosTxSchema).parse(json)[0];

/** undefined = Koios does not know the tx (not on chain yet, or indexer lag). */
export async function fetchKoiosTx(
  txHash: string
): Promise<KoiosTx | undefined> {
  const json = await request(`${bridgeEnv.KOIOS_URL}/tx_info`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      _tx_hashes: [normalizeTxid(txHash)],
      _metadata: true,
      _assets: true,
    }),
  });
  return parseKoiosTx(json);
}

export type ArrivalCheck =
  | { ok: true; outRef: OutRef; quantity: bigint; lovelace: bigint }
  | {
      ok: false;
      reason:
        | 'TX_NOT_FOUND'
        | 'METADATA_MISMATCH'
        | 'NO_MATCHING_OUTPUT'
        | 'MULTIPLE_MATCHING_OUTPUTS';
    };

const bridgeMetadata = z.object({
  uniqueId: z.string(),
  tokenPairID: z.coerce.number(),
});

export function verifyCardanoArrival(
  tx: KoiosTx | undefined,
  expected: {
    redeemHash: string;
    destination: string;
    /** Lucid unit (policy id + asset name hex). */
    unit: string;
    btcTxid: string;
  }
): ArrivalCheck {
  if (!tx || tx.tx_hash !== normalizeTxid(expected.redeemHash)) {
    return { ok: false, reason: 'TX_NOT_FOUND' };
  }
  const meta = bridgeMetadata.safeParse(tx.metadata?.['1']);
  if (
    !meta.success ||
    meta.data.uniqueId.toLowerCase() !==
      '0x' + normalizeTxid(expected.btcTxid) ||
    meta.data.tokenPairID !== TOKEN_PAIR_ID
  ) {
    return { ok: false, reason: 'METADATA_MISMATCH' };
  }
  const destination = getAddressDetails(expected.destination).address.bech32;
  const matches = tx.outputs.flatMap((o) => {
    const quantity = (o.asset_list ?? [])
      .filter((a) => a.policy_id + (a.asset_name ?? '') === expected.unit)
      .reduce((sum, a) => sum + a.quantity, 0n);
    return o.payment_addr.bech32 === destination && quantity > 0n
      ? [{ o, quantity }]
      : [];
  });
  if (matches.length === 0) return { ok: false, reason: 'NO_MATCHING_OUTPUT' };
  if (matches.length > 1)
    return { ok: false, reason: 'MULTIPLE_MATCHING_OUTPUTS' };
  const [{ o, quantity }] = matches;
  return {
    ok: true,
    outRef: { txHash: tx.tx_hash, outputIndex: o.tx_index },
    quantity,
    lovelace: o.value,
  };
}
