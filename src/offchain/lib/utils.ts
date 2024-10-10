import {
  credentialToAddress,
  getAddressDetails,
  LucidEvolution,
} from "@lucid-evolution/lucid";
import { AddressT } from "./types";

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

export { dataAddressToBech32, bech32ToAddressType };
