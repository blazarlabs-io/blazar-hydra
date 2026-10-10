import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { exportJWK, generateKeyPair, JWTPayload, SignJWT } from 'jose';
import { randomUUID } from 'crypto';
import { prisma } from '../../config';
import {
  requireAccount,
  requireAdmin,
  requireAdminOrOwner,
  sha256Hex,
  verifyFirebaseIdToken,
} from './auth';

const PROJECT = 'test-project'; // FIREBASE_PROJECT_ID in vitest.config.ts
const ISS = `https://securetoken.google.com/${PROJECT}`;
const now = () => Math.floor(Date.now() / 1000);

let googleKey: CryptoKey;
let otherKey: CryptoKey;
const fetchMock = vi.fn();

const sign = (claims: JWTPayload, key = googleKey, kid = 'k1') =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid }).sign(key);
const valid = (sub: string, over: JWTPayload = {}) =>
  sign({
    iss: ISS,
    aud: PROJECT,
    sub,
    iat: now() - 10,
    exp: now() + 3590,
    ...over,
  });

beforeAll(async () => {
  const g = await generateKeyPair('RS256');
  googleKey = g.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = {
    ...(await exportJWK(g.publicKey)),
    kid: 'k1',
    alg: 'RS256',
    use: 'sig',
  };
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { 'content-type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fetchMock);
});

describe('verifyFirebaseIdToken', () => {
  it('accepts a valid token, fetching the Google JWKS once (cached)', async () => {
    expect(await verifyFirebaseIdToken(await valid('uid-1'))).toBe('uid-1');
    expect(await verifyFirebaseIdToken(await valid('uid-2'))).toBe('uid-2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
    );
  });

  it.each([
    ['wrong audience', { aud: 'other-project' }],
    ['wrong issuer', { iss: 'https://securetoken.google.com/other-project' }],
    ['expired', { iat: now() - 7200, exp: now() - 3600 }],
    ['issued in the future', { iat: now() + 600, exp: now() + 4200 }],
    ['empty subject', { sub: '' }],
  ])('rejects a token with %s', async (_name, over) => {
    await expect(
      verifyFirebaseIdToken(await valid('uid-1', over))
    ).rejects.toThrow();
  });

  it('rejects a token signed by another key, an unknown kid, or HS256', async () => {
    const claims = {
      iss: ISS,
      aud: PROJECT,
      sub: 'u',
      iat: now(),
      exp: now() + 60,
    };
    await expect(
      verifyFirebaseIdToken(await sign(claims, otherKey))
    ).rejects.toThrow();
    await expect(
      verifyFirebaseIdToken(await sign(claims, otherKey, 'k2'))
    ).rejects.toThrow();
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .sign(new TextEncoder().encode('x'.repeat(32)));
    await expect(verifyFirebaseIdToken(hs)).rejects.toThrow();
  });
});

function call(
  handler: ReturnType<typeof requireAccount>,
  authorization?: string,
  body?: unknown
) {
  const req = { headers: { authorization }, body } as unknown as Request;
  const res = {
    locals: {} as Record<string, unknown>,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return Promise.resolve(handler(req, res as unknown as Response, next)).then(
    () => ({ res, next })
  );
}

describe('requireAccount / requireAdmin', () => {
  const uid = `uid-${randomUUID()}`;
  const deviceKey = `device-${randomUUID()}-${randomUUID()}`;

  beforeAll(async () => {
    await prisma.account.create({
      data: { kind: 'user', address: 'addr_user', firebaseUid: uid },
    });
    await prisma.account.create({
      data: {
        kind: 'merchant',
        address: 'addr_merchant',
        apiKeyHash: sha256Hex(deviceKey),
      },
    });
  });

  it('maps a Firebase ID token to its user account', async () => {
    const { res, next } = await call(
      requireAccount('user'),
      `Bearer ${await valid(uid)}`
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.caller).toMatchObject({
      kind: 'user',
      address: 'addr_user',
    });
  });

  it('maps a device key to its merchant account, and enforces the account kind', async () => {
    const ok = await call(requireAccount('merchant'), `Bearer ${deviceKey}`);
    expect(ok.next).toHaveBeenCalledOnce();
    expect(ok.res.locals.caller).toMatchObject({
      kind: 'merchant',
      address: 'addr_merchant',
    });

    const terminalAuthorizing = await call(
      requireAccount('user'),
      `Bearer ${deviceKey}`
    );
    expect(terminalAuthorizing.next).not.toHaveBeenCalled();
    expect(terminalAuthorizing.res.status).toHaveBeenCalledWith(403);
  });

  it.each([
    ['no header', undefined],
    ['not a bearer', 'Basic abc'],
    ['unknown device key', 'Bearer nope-nope-nope'],
    ['unmapped Firebase uid', 'VALID_UNMAPPED'],
    ['forged token', 'FORGED'],
  ])('401 for %s', async (_name, header) => {
    if (header === 'VALID_UNMAPPED')
      header = `Bearer ${await valid('uid-unmapped')}`;
    if (header === 'FORGED')
      header = `Bearer ${await sign({ iss: ISS, aud: PROJECT, sub: uid, iat: now(), exp: now() + 60 }, otherKey)}`;
    const { res, next } = await call(requireAccount(), header);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('requireAdmin accepts only ADMIN_API_KEY', async () => {
    const admin = (h?: string) =>
      call(requireAdmin as ReturnType<typeof requireAccount>, h);
    expect(
      (await admin('Bearer test-admin-key-0123456789abcdef0123')).next
    ).toHaveBeenCalledOnce();
    for (const h of [
      undefined,
      'Bearer wrong',
      'test-admin-key-0123456789abcdef0123',
      `Bearer ${deviceKey}`,
    ]) {
      const { res, next } = await admin(h);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('requireAdminOrOwner (/withdraw, /deposit): admin, or the Firebase owner of the address', async () => {
    const owner = requireAdminOrOwner((b) => b.address);
    const admin = await call(
      owner,
      'Bearer test-admin-key-0123456789abcdef0123',
      {
        address: 'addr_anyone',
      }
    );
    expect(admin.next).toHaveBeenCalledOnce();

    const self = await call(owner, `Bearer ${await valid(uid)}`, {
      address: 'addr_user',
    });
    expect(self.next).toHaveBeenCalledOnce();
    expect(self.res.locals.caller).toMatchObject({ address: 'addr_user' });

    const other = await call(owner, `Bearer ${await valid(uid)}`, {
      address: 'addr_merchant',
    });
    expect(other.next).not.toHaveBeenCalled();
    expect(other.res.status).toHaveBeenCalledWith(403);

    // no auth, a forged token, and the merchant's own device key (a terminal must not move funds)
    for (const h of [
      undefined,
      `Bearer ${await sign({ iss: ISS, aud: PROJECT, sub: uid, iat: now(), exp: now() + 60 }, otherKey)}`,
      `Bearer ${deviceKey}`,
    ]) {
      const { res, next } = await call(owner, h, { address: 'addr_merchant' });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });
});
