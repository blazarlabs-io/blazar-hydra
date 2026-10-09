import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';
import { submitTxAndAwaitSnapshot } from './hydra';

const OURS = 'aa'.repeat(32);
const OTHER = 'bb'.repeat(32);
const tx = (txId: string) => ({
  txId,
  cborHex: '84a0',
  description: '',
  type: 'Tx ConwayEra',
});
const confirmed = (number: number, ids: string[]) => ({
  tag: 'SnapshotConfirmed',
  snapshot: { number, confirmed: ids.map(tx) },
});

// The fake hydra-node answers each NewTx with the script of the current test.
let script: object[] = [];
let lastUrl = '';
let server: WebSocketServer;
let url: string;

beforeAll(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.once('listening', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  server.on('connection', (ws, req) => {
    lastUrl = req.url ?? '';
    ws.send(JSON.stringify({ tag: 'Greetings', headStatus: 'Open' }));
    ws.on('message', (m) => {
      if (JSON.parse(m.toString()).tag === 'NewTx')
        script.forEach((s) => ws.send(JSON.stringify(s)));
    });
  });
});
afterAll(() => server.close());

describe('submitTxAndAwaitSnapshot', () => {
  it('resolves only on the SnapshotConfirmed that contains our tx', async () => {
    script = [
      { tag: 'TxValid', transactionId: OURS },
      { tag: 'TxInvalid', transaction: tx(OTHER) }, // someone else's failure
      confirmed(5, [OTHER]), // someone else's snapshot
      confirmed(6, [OTHER, OURS]),
    ];
    expect(await submitTxAndAwaitSnapshot(url, '84a0', OURS, 2000)).toEqual({
      outcome: 'confirmed',
      snapshotNumber: 6,
    });
    expect(lastUrl).toContain('history=no');
    expect(lastUrl).toContain('snapshot-utxo=no');
  });

  it('TxInvalid for our tx is invalid', async () => {
    script = [
      {
        tag: 'TxInvalid',
        transaction: tx(OURS),
        validationError: { reason: 'x' },
      },
    ];
    expect(await submitTxAndAwaitSnapshot(url, '84a0', OURS, 2000)).toEqual({
      outcome: 'invalid',
    });
  });

  it('TxValid alone is not success: times out as pending', async () => {
    script = [{ tag: 'TxValid', transactionId: OURS }, confirmed(7, [OTHER])];
    expect(await submitTxAndAwaitSnapshot(url, '84a0', OURS, 300)).toEqual({
      outcome: 'pending',
    });
  });

  it('an unreachable node is pending (reconcile decides), never a throw', async () => {
    expect(
      await submitTxAndAwaitSnapshot('ws://127.0.0.1:9', '84a0', OURS, 300)
    ).toEqual({
      outcome: 'pending',
    });
  });
});
