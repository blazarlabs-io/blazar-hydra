import { afterEach, describe, expect, it } from 'vitest';
import { AddressInfo, createServer, Server, Socket } from 'net';
import { postDecommit } from './hydra';

// hydra-node 2.4 (unstable) was seen accepting a decommit and closing the /decommit connection
// without an answer (12 Oct 2026): the decommit went through, the backend gave up on it.
let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});
const listen = (onConnection: (socket: Socket) => void) =>
  new Promise<string>((resolve) => {
    server = createServer(onConnection);
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/decommit`)
    );
  });

describe('postDecommit', () => {
  it('a connection closed without an answer counts as sent: the snapshot decides (awaitDecommit)', async () => {
    const url = await listen((socket) => socket.once('data', () => socket.destroy()));
    await expect(postDecommit(url, '84a0')).resolves.toBeUndefined();
  });

  it('rejects when hydra-node answers with an error status', async () => {
    const url = await listen((socket) =>
      socket.once('data', () =>
        socket.end('HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}')
      )
    );
    await expect(postDecommit(url, '84a0')).rejects.toThrow(/400/);
  });

  it('rejects when the request never reached hydra-node', async () => {
    const url = await listen(() => {});
    await new Promise((r) => server!.close(r));
    server = undefined;
    await expect(postDecommit(url, '84a0')).rejects.toThrow();
  });
});
