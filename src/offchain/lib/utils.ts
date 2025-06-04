import {
  CML,
  credentialToAddress,
  fromHex,
  getAddressDetails,
  LucidEvolution,
  Network,
  Script,
  UTxO,
} from '@lucid-evolution/lucid';
import { AddressT, CredentialT } from './types';
import { mnemonicToEntropy } from 'bip39';
import { logger } from '../../logger';
import { buildValidator } from '../validator/handle';

function dataAddressToBech32(lucid: LucidEvolution, add: AddressT): string {
  const paymentCred = add.payment_credential;
  const stakeCred = add.stake_credential;
  let paymentKey;
  let stakeKey;
  if ('Verification_key_cred' in paymentCred) {
    paymentKey = paymentCred.Verification_key_cred.Key;
  } else {
    paymentKey = paymentCred.Script_cred.Key;
  }
  if (stakeCred) {
    if ('inline' in stakeCred && 'Verification_key_cred' in stakeCred.inline) {
      stakeKey = stakeCred.inline.Verification_key_cred.Key;
    }
  } else {
    stakeKey = null;
  }
  const network = getNetworkFromLucid(lucid);
  return credentialToAddress(
    network,
    { type: 'Key', hash: paymentKey },
    stakeKey ? { type: 'Key', hash: stakeKey } : undefined
  );
}

function bech32ToAddressType(lucid: LucidEvolution, add: string): AddressT {
  const addressDetails = getAddressDetails(add);
  if (!addressDetails.paymentCredential) {
    throw new Error('Invalid address');
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
    addressType?: 'Base' | 'Enterprise';
    accountIndex?: number;
    network?: Network;
  } = { addressType: 'Base', accountIndex: 0, network: 'Mainnet' }
): CML.PrivateKey {
  function harden(num: number): number {
    if (typeof num !== 'number') throw new Error('Type number required here!');
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
  address: string,
  txId: string
): Promise<void> {
  let userUtxosUpdated = false;
  let scriptUtxoUpdated = false;
  while (!scriptUtxoUpdated || !userUtxosUpdated) {
    logger.info('Waiting for utxos update...');
    await new Promise((r) => setTimeout(r, 10000));
    try {
      const utxos = await lucid.utxosAt(address);
      const scriptUtxos = await lucid.utxosByOutRef([
        { txHash: txId, outputIndex: 0 },
      ]);
      userUtxosUpdated = utxos.some((utxo) => utxo.txHash === txId);
      scriptUtxoUpdated = scriptUtxos.length !== 0;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      logger.info('Failed to fetch utxos from blockfrost, retrying...');
    }
  }
  // wait for 20 more seconds because sometimes it is insufficient
  await new Promise((r) => setTimeout(r, 20000));
}

function getValidator(
  validatorRef: UTxO | undefined,
  adminKey?: string,
  hydraKey?: string
): Script {
  if (!validatorRef) {
    if (!(adminKey || hydraKey)) {
      throw new Error(
        'Must include validator reference or validator parameters'
      );
    } else {
      const hydraCred: CredentialT = { Script_cred: { Key: hydraKey! } };
      return buildValidator(adminKey!, hydraCred);
    }
  } else {
    if (!validatorRef.scriptRef) {
      throw new Error('Validator script not found in UTxO');
    }
    return validatorRef.scriptRef;
  }
}

function getNetworkFromLucid(lucid: LucidEvolution): Network {
  const network = lucid.config().network;
  if (!network) {
    throw new Error('Lucid network configuration is not set.');
  }
  return network;
}

export {
  dataAddressToBech32,
  bech32ToAddressType,
  getNetworkFromLucid,
  getPrivateKey,
  getValidator,
  waitForUtxosUpdate,
};
