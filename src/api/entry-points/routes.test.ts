import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { credentialToAddress, LucidEvolution } from '@lucid-evolution/lucid';
import { createServer } from './server';
import { setRoutes } from './routes';
import { API_ROUTES } from '../schemas/routes';
import { prisma } from '../../config';
import { DepositDeps } from '../../offchain/handlers/btc-deposit';
import { parseBtcTx, parseQuotaAndFee } from '../../bridge/wanbridge';
import mempoolFx from '../../bridge/wanbridge/__fixtures__/mempool-tx-6633762d.json';
import quotaFx from '../../bridge/wanbridge/__fixtures__/quotaAndFee-517.json';

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
const otherUserKey = `o-${randomUUID()}-${randomUUID()}`;
const BTC_TXID = mempoolFx.txid;
const unused = async (): Promise<never> => {
  throw new Error('not used over HTTP');
};
// Bridge answers from the recorded pair-517 deposit; the poller (Hydra side) is not exercised here.
const deposits: DepositDeps = {
  bridge: {
    getQuotaAndFee: async () => parseQuotaAndFee(quotaFx),
    createTx2: async ({ amountSats }) => ({
      depositAddress: mempoolFx.vout[0].scriptpubkey_address!,
      valueSats: amountSats,
      memo: mempoolFx.vout[1].scriptpubkey.slice(4),
      receiveSats: amountSats - 320n,
    }),
    fetchBtcTx: async () => parseBtcTx(mempoolFx),
    getStatus: unused,
    fetchKoiosTx: unused,
  },
  snapshot: unused,
  fundsUtxo: unused,
  submitCommit: unused,
  awaitCommit: unused,
  recover: unused,
};

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
  setRoutes(lucid, app, deposits);
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

  it.each([API_ROUTES.DEPOSIT, API_ROUTES.WITHDRAW])(
    '%s accepts ADMIN_API_KEY (/withdraw owner tokens: auth.test.ts)',
    async (path) => {
      // past auth: the empty body fails validation
      expect((await api(path, ADMIN, {})).status).toBe(500);
    }
  );

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

  it('BTC deposits: user-only, integer-string sats, own deposits only', async () => {
    await prisma.deposit.deleteMany();
    const u = `Bearer ${userKey}`;
    const other = `Bearer ${otherUserKey}`;
    expect(
      (await api(API_ROUTES.ACCOUNTS, ADMIN, { kind: 'user', address: USER, apiKey: otherUserKey })).status
    ).toBe(201);

    expect((await api(API_ROUTES.BTC_DEPOSITS, undefined, { amountSats: '200000' })).status).toBe(401);
    expect((await api(API_ROUTES.BTC_DEPOSITS, `Bearer ${merchantKey}`, { amountSats: '200000' })).status).toBe(403);
    for (const bad of [200000, '0', '1.5', '-5', '0200000', ''])
      expect((await api(API_ROUTES.BTC_DEPOSITS, u, { amountSats: bad })).status).toBe(400);
    expect((await api(API_ROUTES.BTC_DEPOSITS, u, { amountSats: '200000', userAddress: USER })).status).toBe(400);

    const created = await api(API_ROUTES.BTC_DEPOSITS, u, { amountSats: '200000' });
    expect(created.status).toBe(201);
    const d = await created.json();
    expect(d).toMatchObject({
      state: 'created',
      userAddress: USER,
      requestedBaseUnits: '200000',
      btc: { toAccount: mempoolFx.vout[0].scriptpubkey_address, valueSats: '200000' },
      btcTxid: null,
    });
    expect(Date.parse(d.expiresAt)).toBeGreaterThan(Date.now() + 29 * 60_000);

    expect((await get(`/deposits/${d.depositId}`, u)).status).toBe(200);
    expect((await get(`/deposits/${d.depositId}`, other)).status).toBe(404);
    expect((await get(`/deposits/${d.depositId}`)).status).toBe(401);

    const attach = (auth: string, btcTxid: unknown) =>
      api(`/deposits/${d.depositId}/btc-tx`, auth, { btcTxid });
    expect((await attach(u, 'xyz')).status).toBe(400);
    expect((await attach(other, BTC_TXID)).status).toBe(404);
    const sent = await attach(u, BTC_TXID.toUpperCase());
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ state: 'btc_sent', btcTxid: BTC_TXID, btcVout: 0 });
    expect((await attach(u, 'ab'.repeat(32))).status).toBe(409);

    const short = await (await api(API_ROUTES.BTC_DEPOSITS, u, { amountSats: '150000' })).json();
    const reclaim = await api(`/deposits/${short.depositId}/btc-tx`, u, { btcTxid: BTC_TXID });
    expect(reclaim.status).toBe(409); // that BTC output already funds the first deposit
  });
});

// Seen live on 6c61097: HTML stack traces, Prisma source excerpts and Buffer keys in replies.
describe('error replies are JSON without internals', () => {
  const post = (path: string, init: RequestInit) =>
    fetch(`${base}${path}`, { method: 'POST', ...init });
  const json = { 'content-type': 'application/json' };
  const clean = async (r: Response, status: number) => {
    expect(r.status).toBe(status);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    const text = await r.text();
    expect(text).not.toMatch(/node_modules|\.ts:\d|Prisma|readUInt|<html/);
    return JSON.parse(text);
  };

  it('malformed JSON is a 400', async () => {
    await clean(await post(API_ROUTES.PAYMENTS, { headers: json, body: '{"a":' }), 400);
  });

  it('body-parser errors (too large, bad encoding) carry no stack', async () => {
    await clean(await post('/nope', { headers: { 'content-type': 'text/plain' }, body: 'a'.repeat(1_100_000) }), 413);
    await clean(await post('/nope', { headers: { ...json, 'content-encoding': 'gzip' }, body: 'notgzip' }), 400);
  });

  it('an empty JSON body is validated as {}', async () => {
    const r = await post(API_ROUTES.ACCOUNTS, { headers: { ...json, authorization: ADMIN }, body: '' });
    const { issues } = await clean(r, 400);
    expect(issues.map((i: { path: string[] }) => i.path[0])).toEqual(['kind', 'address']);
  });

  it('GET /state: 404 for a missing, repeated or unknown id', async () => {
    for (const q of ['', '?id=a&id=b', `?id=${randomUUID()}`])
      expect(await clean(await get(`/state${q}`), 404)).toEqual({ error: 'NOT_FOUND' });
    const p = await prisma.process.create({ data: { status: 'RUNNING' } });
    expect(await (await get(`/state?id=${p.id}`)).json()).toEqual({ status: 'RUNNING' });
  });

  it('GET /query-funds rejects a missing or invalid address', async () => {
    for (const q of ['', '?address=garbage', `?address=${USER}&address=${USER}`])
      await clean(await get(`${API_ROUTES.QUERY_FUNDS}${q}`), 400);
  });
});
