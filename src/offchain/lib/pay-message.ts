import { CML, getAddressDetails } from '@lucid-evolution/lucid';

/** Plutus Data as the validator's `cbor.serialise` sees it. */
export type PlutusData =
  | { constr: number; fields: PlutusData[] }
  | { map: [PlutusData, PlutusData][] }
  | { bytes: string }
  | { int: bigint };

const cborHead = (major: number, n: bigint): string => {
  const m = major << 5;
  if (n < 24n) return (m | Number(n)).toString(16).padStart(2, '0');
  if (n < 256n) return (m | 24).toString(16) + n.toString(16).padStart(2, '0');
  if (n < 65536n) return (m | 25).toString(16) + n.toString(16).padStart(4, '0');
  if (n < 4294967296n) return (m | 26).toString(16) + n.toString(16).padStart(8, '0');
  return (m | 27).toString(16) + n.toString(16).padStart(16, '0');
};

/**
 * CBOR exactly as Plutus `serialiseData` (Aiken `cbor.serialise`): constructor fields as an indefinite
 * list (9f..ff; none: 80), maps and byte strings with definite length. Lucid's Data.to differs (definite
 * arrays with `canonical`, indefinite maps without), so the signed message is built here, never with Data.to.
 * ponytail: byte strings over 64 bytes and constructors >= 7 never occur in PayInfo; add them if they do.
 */
export function plutusCbor(d: PlutusData): string {
  if ('int' in d) return d.int >= 0n ? cborHead(0, d.int) : cborHead(1, -d.int - 1n);
  if ('bytes' in d) {
    if (d.bytes.length > 128) throw new Error('byte strings over 64 bytes are not supported');
    return cborHead(2, BigInt(d.bytes.length / 2)) + d.bytes.toLowerCase();
  }
  if ('map' in d) {
    return cborHead(5, BigInt(d.map.length)) + d.map.map(([k, v]) => plutusCbor(k) + plutusCbor(v)).join('');
  }
  if (d.constr > 6) throw new Error('constructors >= 7 are not supported');
  const fields = d.fields.length === 0 ? '80' : `9f${d.fields.map(plutusCbor).join('')}ff`;
  return `d8${(121 + d.constr).toString(16)}${fields}`;
}

const credential = (c: { type: 'Key' | 'Script'; hash: string }): PlutusData => ({
  constr: c.type === 'Key' ? 0 : 1,
  fields: [{ bytes: c.hash }],
});

/** Plutus `Address` of a Shelley base or enterprise address; other address types are refused. */
export function addressData(bech32: string): PlutusData {
  const details = getAddressDetails(bech32);
  const { paymentCredential, stakeCredential } = details;
  if (!paymentCredential || (details.type !== 'Base' && details.type !== 'Enterprise')) {
    throw new Error(`unsupported merchant address: ${details.type}`);
  }
  // The tx builder (bech32ToAddressType) encodes every credential as a key, so a script one would not match.
  if (paymentCredential.type !== 'Key' || (stakeCredential && stakeCredential.type !== 'Key')) {
    throw new Error('unsupported merchant address: script credential');
  }
  const stake: PlutusData = stakeCredential
    ? { constr: 0, fields: [{ constr: 0, fields: [credential(stakeCredential)] }] } // Some(Inline(cred))
    : { constr: 1, fields: [] }; // None
  return { constr: 0, fields: [credential(paymentCredential), stake] };
}

export type PayMessageInput = {
  merchantAddress: string;
  assetUnit: string; // 'lovelace' or policy id (56 hex) + asset name hex
  amountBaseUnits: string;
  fundsInRef: string; // '<txHash>#<index>' of the payer funds UTxO the payment spends
};

/** PayInfo { amount, merchant_addr, ref }: what the payer signs and the validator checks. */
export function payInfoData(p: PayMessageInput): PlutusData {
  const lovelace = p.assetUnit === 'lovelace';
  const m = /^([0-9a-f]{64})#(\d+)$/.exec(p.fundsInRef);
  if (!m) throw new Error(`bad fundsInRef: ${p.fundsInRef}`);
  return {
    constr: 0,
    fields: [
      {
        map: [
          [
            { bytes: lovelace ? '' : p.assetUnit.slice(0, 56) },
            { map: [[{ bytes: lovelace ? '' : p.assetUnit.slice(56) }, { int: BigInt(p.amountBaseUnits) }]] },
          ],
        ],
      },
      addressData(p.merchantAddress),
      { constr: 0, fields: [{ bytes: m[1] }, { int: BigInt(m[2]) }] },
    ],
  };
}

export const payInfoCbor = (p: PayMessageInput): string => plutusCbor(payInfoData(p));

/** True when `signatureHex` is the ed25519 signature of `messageHex` by `publicKeyHex`. Never throws. */
export function verifyPaySignature(publicKeyHex: string, messageHex: string, signatureHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
  try {
    return CML.PublicKey.from_bytes(Buffer.from(publicKeyHex, 'hex')).verify(
      Buffer.from(messageHex, 'hex'),
      CML.Ed25519Signature.from_hex(signatureHex)
    );
  } catch {
    return false;
  }
}
