import { describe, it, expect } from 'vitest';
import { Blockfrost, Kupmios } from '@lucid-evolution/lucid';
import { makeProvider } from './provider';
import type { EnvSchema } from '../../config';

// Minimal env stub; only the provider-relevant fields matter for makeProvider.
const base = {
  PORT: 3001,
  NETWORK: 'Preprod',
  VALIDATOR_REF: 'ref',
  HYDRA_KEY: 'hk',
  SEED: 'seed',
  ADMIN_NODE_WS_URL: 'ws://x',
  ADMIN_NODE_API_URL: 'http://x',
  LOGGER_LEVEL: 'info',
} as unknown as EnvSchema;

describe('makeProvider', () => {
  it('returns Blockfrost when PROVIDER_TYPE=blockfrost', () => {
    const env = { ...base, PROVIDER_TYPE: 'blockfrost', PROVIDER_URL: 'http://bf', PROVIDER_PROJECT_ID: 'pid' } as EnvSchema;
    expect(makeProvider(env)).toBeInstanceOf(Blockfrost);
  });

  it('returns Kupmios when PROVIDER_TYPE=kupmios', () => {
    const env = { ...base, PROVIDER_TYPE: 'kupmios', KUPO_URL: 'http://kupo:1442', OGMIOS_URL: 'http://ogmios:1337' } as EnvSchema;
    expect(makeProvider(env)).toBeInstanceOf(Kupmios);
  });

  it('throws when kupmios is selected without KUPO_URL/OGMIOS_URL', () => {
    const env = { ...base, PROVIDER_TYPE: 'kupmios' } as EnvSchema;
    expect(() => makeProvider(env)).toThrow(/KUPO_URL and OGMIOS_URL/);
  });

  it('throws when blockfrost is selected without PROVIDER_URL/PROVIDER_PROJECT_ID', () => {
    const env = { ...base, PROVIDER_TYPE: 'blockfrost' } as EnvSchema;
    expect(() => makeProvider(env)).toThrow(/PROVIDER_URL and PROVIDER_PROJECT_ID/);
  });
});
