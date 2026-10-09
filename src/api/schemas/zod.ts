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

export const network = env.NETWORK as Network;

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
    .regex(/^[0-9a-fA-F]/, 'Public key must be a hex string')
    .optional(),
  amount: z.array(z.tuple([z.string(), z.bigint()])),
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
  amount: z.array(z.tuple([z.string(), z.bigint()])),
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

const IncrementalCommitZodSchema = z.object({
  user_address: addressSchema,
  public_key: z
    .string()
    .regex(/^[0-9a-fA-F]/, 'Public key must be a hex string')
    .optional(),
  amount: z.array(z.tuple([z.string(), z.bigint()])),
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

const IncrementalDecommitZodSchema = z.object({
  address: addressSchema,
  owner: z.enum(['user', 'merchant']),
  funds_utxo_ref: z.object({
    hash: z
      .string()
      .length(64, 'Transaction hash must be 64 characters long.')
      .regex(/^[0-9a-fA-F]/, 'Transaction hash must be a hex string.'),
    index: z.bigint(),
  }),
  signature: z.string().optional(),
});

/** POST /accounts (admin seeding): a Firebase uid and/or a device key mapped to one address. */
const CreateAccountZodSchema = z
  .object({
    firebaseUid: z.string().min(1).optional(),
    apiKey: z
      .string()
      .min(32, 'apiKey must be at least 32 characters')
      .optional(),
    kind: z.enum(['user', 'merchant']),
    address: addressSchema,
  })
  .strict()
  .refine((a) => a.firebaseUid || a.apiKey, {
    message: 'firebaseUid or apiKey is required',
  });

export {
  Layer,
  CreateAccountZodSchema,
  DepositZodSchema,
  ManageHeadZodSchema,
  PayMerchantZodSchema,
  WithdrawZodSchema,
  IncrementalCommitZodSchema,
  IncrementalDecommitZodSchema,
};
