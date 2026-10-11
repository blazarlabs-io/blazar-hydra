import { describe, expect, it } from 'vitest';
import { credentialToAddress } from '@lucid-evolution/lucid';
import { prisma } from '../../config';
import { NoPublicKeyError, registeredPublicKey, userPublicKeyFor } from './accounts';

const addr = (b: string) =>
  credentialToAddress('Preprod', { type: 'Key', hash: b.repeat(28) }, { type: 'Key', hash: '0f'.repeat(28) });
const PK = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';

describe('user public keys', () => {
  it('uses the registered key, prefers an explicit one, and refuses an address without one', async () => {
    const withKey = addr('c1');
    const without = addr('c2');
    await prisma.account.create({ data: { kind: 'user', address: withKey, apiKeyHash: 'accounts-test-c1', publicKey: PK } });
    await prisma.account.create({ data: { kind: 'user', address: without, apiKeyHash: 'accounts-test-c2' } });
    expect(await registeredPublicKey(withKey)).toBe(PK);
    expect(await registeredPublicKey(without)).toBeUndefined();
    expect(await userPublicKeyFor(withKey)).toBe(PK);
    expect(await userPublicKeyFor(withKey, '81'.repeat(32))).toBe('81'.repeat(32));
    await expect(userPublicKeyFor(without)).rejects.toBeInstanceOf(NoPublicKeyError);
    await expect(userPublicKeyFor(addr('c3'))).rejects.toBeInstanceOf(NoPublicKeyError);
  });
});
