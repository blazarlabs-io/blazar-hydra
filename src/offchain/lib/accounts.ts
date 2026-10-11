import { prisma } from '../../config';

export class NoPublicKeyError extends Error {
  constructor(address: string) {
    super(`No device public key registered for ${address}`);
  }
}

/** The device public key registered by a user account with this address, if any. */
export async function registeredPublicKey(address: string): Promise<string | undefined> {
  const a = await prisma.account.findFirst({
    where: { address, kind: 'user', publicKey: { not: null } },
    orderBy: { id: 'asc' },
  });
  return a?.publicKey ?? undefined;
}

/**
 * The key locked into a User funds datum: the explicit one, else the registered one. Funds under no
 * real key could never be paid out (the validator checks the payer's signature), so that is refused.
 */
export async function userPublicKeyFor(address: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const k = await registeredPublicKey(address);
  if (!k) throw new NoPublicKeyError(address);
  return k;
}
