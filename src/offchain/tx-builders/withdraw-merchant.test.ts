import { describe, expect, it } from 'vitest';
import { LucidEvolution } from '@lucid-evolution/lucid';
import { withdrawMerchant } from './withdraw-merchant';

describe('withdrawMerchant (burns the validation token inside L2)', () => {
  it('refuses user funds: their token was minted on L1, and burning it in L2 blocks the fanout (H4)', async () => {
    const lucid = { config: () => ({ network: 'Preprod' }) } as unknown as LucidEvolution;
    await expect(
      withdrawMerchant(lucid, { kind: 'user', withdraws: [], adminKey: 'ad'.repeat(28), hydraKey: 'aa'.repeat(28) })
    ).rejects.toThrow(/user funds/i);
  });
});
