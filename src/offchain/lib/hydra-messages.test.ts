import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitForTag, HydraTerminalError, MessageConn } from './hydra-messages';

afterEach(() => vi.useRealTimers());

function fakeConn(): MessageConn & { emit: (m: unknown) => void } {
  const conn: any = { onmessage: null };
  conn.emit = (m: unknown) =>
    conn.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  return conn;
}

describe('waitForTag', () => {
  it('resolves on the target tag', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'HeadIsOpen');
    c.emit({ tag: 'HeadIsOpen', headId: 'h1' });
    await expect(p).resolves.toMatchObject({ tag: 'HeadIsOpen', headId: 'h1' });
  });

  it('ignores non-matching tags then resolves', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'CommitFinalized');
    c.emit({ tag: 'CommitRecorded' });
    c.emit({ tag: 'CommitApproved' });
    c.emit({ tag: 'CommitFinalized', depositTxId: 'd1' });
    await expect(p).resolves.toMatchObject({ depositTxId: 'd1' });
  });

  it('honors the match predicate (correlate on depositTxId)', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'CommitFinalized', {
      match: (m) => m.depositTxId === 'mine',
    });
    c.emit({ tag: 'CommitFinalized', depositTxId: 'other' });
    c.emit({ tag: 'CommitFinalized', depositTxId: 'mine' });
    await expect(p).resolves.toMatchObject({ depositTxId: 'mine' });
  });

  it('rejects on a terminal tag', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'CommitFinalized', { terminalTags: ['DepositExpired'] });
    c.emit({ tag: 'DepositExpired', depositTxId: 'd1' });
    await expect(p).rejects.toBeInstanceOf(HydraTerminalError);
  });

  it('ignores non-JSON frames', async () => {
    const c = fakeConn();
    const p = waitForTag(c, 'TxValid');
    c.emit('not-json');
    c.emit({ tag: 'TxValid' });
    await expect(p).resolves.toMatchObject({ tag: 'TxValid' });
  });

  it('times out', async () => {
    vi.useFakeTimers();
    const c = fakeConn();
    const p = waitForTag(c, 'HeadIsOpen', { timeout: 1000 });
    const assertion = expect(p).rejects.toThrow(/Timeout/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });
});
