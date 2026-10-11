import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { credentialToAddress, LucidEvolution } from '@lucid-evolution/lucid';
import { createServer } from './server';
import { setRoutes } from './routes';
import { API_ROUTES } from '../schemas/routes';

// Real Express app and DB; Hydra (127.0.0.1:9 in vitest.config.ts) is unreachable.
const lucid = {
  config: () => ({ network: 'Preprod' }),
} as unknown as LucidEvolution;
const ADMIN = 'Bearer test-admin-key-0123456789abcdef0123';
const addr = (b: string) =>
  credentialToAddress(
    'Preprod',
    { type: 'Key', hash: b.repeat(28) },
    { type: 'Key', hash: '0f'.repeat(28) }
  );
const MERCHANT = addr('e1');
const USER = addr('e2');
const merchantKey = `m-${randomUUID()}-${randomUUID()}`;
const userKey = `u-${randomUUID()}-${randomUUID()}`;

let server: Server;
let base: string;
const api = (path: string, auth?: string, body?: unknown, method = 'POST') =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: auth } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string, auth?: string) => api(path, auth, undefined, 'GET');

beforeAll(async () => {
  const app = createServer();
  setRoutes(lucid, app);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('routes', () => {
  it.each([
    API_ROUTES.DEPOSIT,
    API_ROUTES.WITHDRAW,
    API_ROUTES.PAY,
    API_ROUTES.OPEN_HEAD,
    API_ROUTES.CLOSE_HEAD,
    API_ROUTES.INCREMENTAL_COMMIT,
    API_ROUTES.INCREMENTAL_DECOMMIT,
    API_ROUTES.ACCOUNTS,
  ])('%s requires ADMIN_API_KEY', async (path) => {
    expect((await api(path, undefined, {})).status).toBe(401);
    expect((await api(path, `Bearer ${merchantKey}`, {})).status).toBe(401);
  });

  it('GET /health reports version and head status', async () => {
    const r = await get(API_ROUTES.HEALTH);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      status: 'ok',
      version: 'dev',
      hydra: 'unreachable',
    });
  });

  it('seeds accounts with the admin key', async () => {
    const seed = (body: object) => api(API_ROUTES.ACCOUNTS, ADMIN, body);
    const m = await seed({
      kind: 'merchant',
      address: MERCHANT,
      apiKey: merchantKey,
    });
    expect(m.status).toBe(201);
    expect(await m.json()).toMatchObject({
      kind: 'merchant',
      address: MERCHANT,
      hasApiKey: true,
    });
    expect(
      (await seed({ kind: 'user', address: USER, apiKey: userKey })).status
    ).toBe(201);
    expect(
      (await seed({ kind: 'user', address: USER, apiKey: userKey })).status
    ).toBe(409);
    expect((await seed({ kind: 'user', address: USER })).status).toBe(400);
    expect(
      (await seed({ kind: 'user', address: 'nope', apiKey: 'x'.repeat(32) }))
        .status
    ).toBe(400);
    expect(
      (await seed({ kind: 'user', address: USER, apiKey: 'short' })).status
    ).toBe(400);
  });

  it('create -> pending -> read -> authorize; Hydra down never reports success', async () => {
    const amount = {
      merchantAddress: MERCHANT,
      assetUnit: 'lovelace',
      amountBaseUnits: '1000000',
    };
    const m = `Bearer ${merchantKey}`;
    const u = `Bearer ${userKey}`;
    expect((await api(API_ROUTES.PAYMENTS, u, amount)).status).toBe(403); // users don't create
    expect(
      (await api(API_ROUTES.PAYMENTS, m, { ...amount, merchantAddress: USER }))
        .status
    ).toBe(403);
    expect(
      (
        await api(API_ROUTES.PAYMENTS, m, {
          ...amount,
          amountBaseUnits: 1000000,
        })
      ).status
    ).toBe(400);

    const created = await api(API_ROUTES.PAYMENTS, m, amount);
    expect(created.status).toBe(201);
    const p = await created.json();
    expect(p).toMatchObject({
      ...amount,
      state: 'created',
      decimals: 6,
      hydraTxId: null,
    });

    const pending = await get(API_ROUTES.TERMINAL_PENDING_PAYMENT, m);
    expect(pending.status).toBe(200);
    expect((await pending.json()).paymentId).toBe(p.paymentId);
    expect((await get(API_ROUTES.TERMINAL_PENDING_PAYMENT, u)).status).toBe(
      403
    );

    expect((await get(`/payments/${p.paymentId}`, u)).status).toBe(200);
    expect((await get(`/payments/${p.paymentId}`)).status).toBe(401);
    expect(
      (await api(`/payments/${p.paymentId}/authorize`, m, {})).status
    ).toBe(403); // terminal can't pay

    const auth = await api(`/payments/${p.paymentId}/authorize`, u, {});
    expect(auth.status).toBe(200);
    expect(await auth.json()).toMatchObject({
      state: 'failed',
      error: 'INTERNAL',
      payerAddress: USER,
    });
    expect((await get(API_ROUTES.TERMINAL_PENDING_PAYMENT, m)).status).toBe(
      204
    );
    expect((await get(`/payments/${randomUUID()}`, m)).status).toBe(404);
  });
});
