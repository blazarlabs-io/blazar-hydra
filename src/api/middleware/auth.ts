import { createHash, timingSafeEqual } from 'crypto';
import { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env, prisma } from '../../config';
import { logger } from '../../shared/logger';

export type AccountKind = 'user' | 'merchant';
export type Caller = { id: string; kind: string; address: string };

const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
// jose caches the keys and refetches only on an unknown `kid` (rate limited).
const googleKeys = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export const sha256Hex = (s: string) =>
  createHash('sha256').update(s).digest('hex');

/** Verifies a Firebase ID token (RS256, Google keys, aud/iss/exp/iat/sub) and returns its uid. */
export async function verifyFirebaseIdToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, googleKeys, {
    algorithms: ['RS256'],
    audience: env.FIREBASE_PROJECT_ID,
    issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    requiredClaims: ['sub', 'iat', 'exp'],
    maxTokenAge: '1h', // also rejects an iat in the future
    clockTolerance: 30,
  });
  if (!payload.sub) throw new Error('empty sub');
  return payload.sub;
}

const bearer = (header: string | undefined) =>
  /^Bearer (\S+)$/.exec(header ?? '')?.[1];

/** Bearer → Account. A JWT is a Firebase ID token; anything else is a device key (sha256 lookup). */
export async function authenticate(
  header: string | undefined
): Promise<Caller | null> {
  const token = bearer(header);
  if (!token) return null;
  if (token.split('.').length === 3) {
    const uid = await verifyFirebaseIdToken(token).catch((e) => {
      logger.debug(`Firebase token rejected: ${e}`);
      return null;
    });
    return uid
      ? prisma.account.findUnique({ where: { firebaseUid: uid } })
      : null;
  }
  return prisma.account.findUnique({ where: { apiKeyHash: sha256Hex(token) } });
}

/** 401 without a known account, 403 when the account kind is not allowed. Sets res.locals.caller. */
export const requireAccount =
  (...kinds: AccountKind[]): RequestHandler =>
  async (req, res, next) => {
    try {
      const caller = await authenticate(req.headers.authorization);
      if (!caller) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (kinds.length && !kinds.includes(caller.kind as AccountKind)) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      res.locals.caller = caller;
      next();
    } catch (e) {
      logger.error(`auth: ${e}`);
      res.status(500).json({ error: 'INTERNAL' });
    }
  };

const isAdmin = (header: string | undefined) => {
  const token = bearer(header);
  return (
    !!token &&
    timingSafeEqual(
      Buffer.from(sha256Hex(token), 'hex'),
      Buffer.from(sha256Hex(env.ADMIN_API_KEY), 'hex')
    )
  );
};

/** Bearer ADMIN_API_KEY, compared in constant time. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (!isAdmin(req.headers.authorization)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }
  next();
};

/**
 * ADMIN_API_KEY, or a Firebase ID token whose account address equals `addressOf(req.body)`.
 * 401 without either, 403 for another address. Device keys are refused: a terminal must not move funds.
 */
export const requireAdminOrOwner =
  (addressOf: (body: Record<string, unknown>) => unknown): RequestHandler =>
  async (req, res, next) => {
    const header = req.headers.authorization;
    if (isAdmin(header)) return next();
    try {
      const isJwt = bearer(header)?.split('.').length === 3;
      const caller = isJwt ? await authenticate(header) : null;
      if (!caller) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }
      if (addressOf(req.body ?? {}) !== caller.address) {
        res.status(403).json({ error: 'FORBIDDEN' });
        return;
      }
      res.locals.caller = caller;
      next();
    } catch (e) {
      logger.error(`auth: ${e}`);
      res.status(500).json({ error: 'INTERNAL' });
    }
  };
