import { prisma } from '../../config';

export class NoPublicKeyError extends Error {
  constructor(address: string) {
    super(`No device public key registered for ${address}`);
  }
}

export class AmbiguousPublicKeyError extends Error {
  constructor(address: string) {
    super(`Different device public keys are registered for ${address}`);
  }
}

/** The device public key registered by the user accounts with this address, if any; never a guess. */
export async function registeredPublicKey(address: string): Promise<string | undefined> {
  const keys = await prisma.account.findMany({
    where: { address, kind: 'user', publicKey: { not: null } },
    select: { publicKey: true },
    distinct: ['publicKey'],
  });
  if (keys.length > 1) throw new AmbiguousPublicKeyError(address);
  return keys[0]?.publicKey ?? undefined;
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
