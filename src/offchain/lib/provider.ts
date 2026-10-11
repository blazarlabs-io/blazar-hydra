import { Blockfrost, Kupmios, Provider } from '@lucid-evolution/lucid';
import type { EnvSchema } from '../../config';

/**
 * Build the Lucid provider selected by env.PROVIDER_TYPE. Centralizes provider construction so the
 * api/index.ts, deploy-validator.ts and demo.ts call sites agree and the Blockfrost<->Kupmios choice
 * is a single env flip. The throws are defense-in-depth; config.ts already enforces the same.
 */
export function makeProvider(env: EnvSchema): Provider {
  if (env.PROVIDER_TYPE === 'kupmios') {
    if (!env.KUPO_URL || !env.OGMIOS_URL) {
      throw new Error('PROVIDER_TYPE=kupmios requires KUPO_URL and OGMIOS_URL');
    }
    return new Kupmios(env.KUPO_URL, env.OGMIOS_URL);
  }
  if (!env.PROVIDER_URL || !env.PROVIDER_PROJECT_ID) {
    throw new Error('PROVIDER_TYPE=blockfrost requires PROVIDER_URL and PROVIDER_PROJECT_ID');
  }
  return new Blockfrost(env.PROVIDER_URL, env.PROVIDER_PROJECT_ID);
}
