import {
  getAddressDetails,
  Network,
  networkToId,
} from '@lucid-evolution/lucid';
import { z, ZodError } from 'zod';
import { env } from '../../config';

enum Layer {
  L1 = 'L1',
  L2 = 'L2',
}

const NETWORKS = {
  MAINNET: {
    url: 'https://cardano-mainnet.blockfrost.io/api/v0',
    network: 'Mainnet',
  },
  PREPROD: {
    url: 'https://cardano-preprod.blockfrost.io/api/v0',
    network: 'Preprod',
  },
  PREVIEW: {
    url: 'https://cardano-preview.blockfrost.io/api/v0',
    network: 'Preview',
  },
} as const;

/**
 * Gets the right url & network for the API
 *
 * @param projectId ProjectId of the Blockfrost API
 * @returns A pair {url, network} according to the `projectId`
 */
function deduceBlockfrostUrlAndNetwork(projectId: string): {
  url: string;
  network: Network;
} {
  if (projectId.includes(NETWORKS.MAINNET.network.toLowerCase())) {
    return NETWORKS.MAINNET;
  }
  if (projectId.includes(NETWORKS.PREVIEW.network.toLowerCase())) {
    return NETWORKS.PREVIEW;
  }
  if (projectId.includes(NETWORKS.PREPROD.network.toLowerCase())) {
    return NETWORKS.PREPROD;
  }
  throw new Error('Invalid projectId');
}

export const { network } = deduceBlockfrostUrlAndNetwork(
  env.PROVIDER_PROJECT_ID
);

export const validateAddressType = (address: string) => {
  return getAddressDetails(address).type === 'Base';
};

export const invalidTypeAddress = {
  message: 'Address should be a Base address',
};

export const validateAddressFormat = (address: string) => {
  try {
    return getAddressDetails(address);
  } catch {
    throw new ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: 'Address should be a valid Cardano address',
        path: ['address'],
      },
    ]);
  }
};

export const invalidFormatAddress = {
  message: 'Address should be a valid Cardano address',
};

export const validateAddressNetwork = (address: string) => {
  return getAddressDetails(address).networkId === networkToId(network);
};

export const invalidAddressNetwork = {
  message: `Address should be of the network ${network}`,
};

export function addressToBech32(address: string): string {
  return getAddressDetails(address).address.bech32;
}

const addressSchema = z
  .string({ description: 'Bech32 Cardano Address' })
  .refine(validateAddressFormat, invalidFormatAddress)
  .refine(validateAddressType, invalidTypeAddress)
  .refine(validateAddressNetwork, invalidAddressNetwork)
  .transform(addressToBech32);

const DepositZodSchema = z.object({
  user_address: addressSchema,
  public_key: z
    .string()
    .regex(/^[0-9a-fA-F]/, 'Public key must be a hex string'),
  amount: z.bigint(),
  funds_utxo_ref: z
    .object({
      hash: z
        .string()
        .length(64, 'Transaction hash must be 64 characters long.')
        .regex(/^[0-9a-fA-F]/, 'Transaction hash must be a hex string.'),
      index: z.bigint(),
    })
    .optional(),
});

const WithdrawZodSchema = z.object({
  address: addressSchema,
  owner: z.enum(['user', 'merchant']),
  funds_utxos: z.array(
    z.object({
      // Signature must be present for user withdrawals
      signature: z.string().optional(),
      ref: z.object({
        hash: z
          .string()
          .length(64, 'Transaction hash must be 64 characters long.')
          .regex(/^[0-9a-fA-F]/, 'Transaction hash must be a hex string.'),
        index: z.bigint(),
      }),
    })
  ),
  network_layer: z.enum(['L1', 'L2']),
});

const PayMerchantZodSchema = z.object({
  merchant_address: addressSchema,
  funds_utxo_ref: z.object({
    hash: z
      .string()
      .length(64, 'Transaction hash must be 64 characters long.')
      .regex(/^[0-9a-fA-F]/, 'Transaction hash must be a hex string.'),
    index: z.bigint(),
  }),
  amount: z.bigint(),
  signature: z.string(),
  merchant_funds_utxo: z
    .object({
      hash: z
        .string()
        .length(64, 'Transaction hash must be 64 characters long.')
        .regex(/^[0-9a-fA-F]/, 'Transaction hash must be a hex string.'),
      index: z.number(),
    })
    .optional(),
});

const ManageHeadZodSchema = z.object({
  peer_api_urls: z.array(z.string()),
});

export {
  Layer,
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
};
