import {
  CML,
  credentialToAddress,
  fromHex,
  getAddressDetails,
  LucidEvolution,
  Network,
} from "@lucid-evolution/lucid";
import { AddressT } from "./types";
import { mnemonicToEntropy } from "bip39";
import { logger } from "../../logger";

function dataAddressToBech32(lucid: LucidEvolution, add: AddressT): string {
  const paymentCred = add.payment_credential;
  const stakeCred = add.stake_credential;
  let paymentKey;
  let stakeKey;
  if ("Verification_key_cred" in paymentCred) {
    paymentKey = paymentCred.Verification_key_cred.Key;
  } else {
    paymentKey = paymentCred.Script_cred.Key;
  }
  if (stakeCred) {
    if ("inline" in stakeCred && "Verification_key_cred" in stakeCred.inline) {
      stakeKey = stakeCred.inline.Verification_key_cred.Key;
    }
  } else {
    stakeKey = null;
  }
  return credentialToAddress(
    lucid.config().network,
    { type: "Key", hash: paymentKey },
    stakeKey ? { type: "Key", hash: stakeKey } : undefined
  );
}

function bech32ToAddressType(lucid: LucidEvolution, add: string): AddressT {
  const addressDetails = getAddressDetails(add);
  if (!addressDetails.paymentCredential) {
    throw new Error("Invalid address");
  }
  return {
    payment_credential: {
      Verification_key_cred: { Key: addressDetails.paymentCredential.hash },
    },
    stake_credential: addressDetails.stakeCredential
      ? {
          inline: {
            Verification_key_cred: {
              Key: addressDetails.stakeCredential.hash,
            },
          },
        }
      : null,
  };
}

function getPrivateKey(
  seed: string,
  options: {
    password?: string;
    addressType?: "Base" | "Enterprise";
    accountIndex?: number;
    network?: Network;
  } = { addressType: "Base", accountIndex: 0, network: "Mainnet" }
): CML.PrivateKey {
  function harden(num: number): number {
    if (typeof num !== "number") throw new Error("Type number required here!");
    return 0x80000000 + num;
  }

  const entropy = mnemonicToEntropy(seed);
  const rootKey = CML.Bip32PrivateKey.from_bip39_entropy(
    fromHex(entropy),
    options.password
      ? new TextEncoder().encode(options.password)
      : new Uint8Array()
  );

  const accountKey = rootKey
    .derive(harden(1852))
    .derive(harden(1815))
    .derive(harden(options.accountIndex!));

  const paymentKey = accountKey.derive(0).derive(0).to_raw_key();
  return paymentKey;
}

async function waitForUtxosUpdate(
  lucid: LucidEvolution,
  txId: string
): Promise<void> {
  let userUtxosUpdated = false;
  let scriptUtxoUpdated = false;
  while (!userUtxosUpdated || !scriptUtxoUpdated) {
    console.info("Waiting for utxos update...");
    await new Promise((r) => setTimeout(r, 10000));
    const utxos = await lucid.wallet().getUtxos();
    const scriptUtxos = await lucid.utxosByOutRef([
      { txHash: txId, outputIndex: 0 },
    ]);
    userUtxosUpdated = utxos.some((utxo) => utxo.txHash === txId);
    scriptUtxoUpdated = scriptUtxos.length !== 0;
  }
  // wait for 20 more seconds because sometimes it is insufficient
  await new Promise((r) => setTimeout(r, 20000));
}

export {
  dataAddressToBech32,
  bech32ToAddressType,
  getPrivateKey,
  waitForUtxosUpdate,
};
