import { logger } from '../../shared/logger';

export interface MessageConn {
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface WaitOptions {
  /** ms before the wait rejects with a Timeout error. Default 60_000. */
  timeout?: number;
  /** tags that reject the wait (failure terminals). */
  terminalTags?: string[];
  /** optional extra predicate the matching message must satisfy. */
  match?: (msg: any) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** observe every parsed message (e.g. progress logging). */
  onMessage?: (msg: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class HydraTerminalError extends Error {
  constructor(
    public readonly tag: string,
    public readonly payload: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ) {
    super(`Received terminal tag '${tag}' while waiting`);
    this.name = 'HydraTerminalError';
  }
}

/**
 * Resolve when a Hydra ServerOutput with `tag` (and optional `match`) arrives.
 * Ignores every other message; rejects on a configured terminal tag or timeout.
 * Replaces the legacy listen()/waitForMessage() which resolved on the first
 * message of ANY tag.
 * Only one outstanding wait per connection is supported: a new waitForTag() call replaces the previous onmessage handler.
 */
export function waitForTag(
  conn: MessageConn,
  tag: string,
  opts: WaitOptions = {}
): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { timeout = 60_000, terminalTags = [], match, onMessage } = opts;
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      conn.onmessage = null;
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`Timeout after ${timeout}ms waiting for tag '${tag}'`));
    }, timeout);

    conn.onmessage = (ev) => {
      let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
      try {
        const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
        data = JSON.parse(raw);
      } catch {
        return; // ignore non-JSON frames
      }
      try {
        onMessage?.(data);
        if (data.tag === tag && (!match || match(data))) {
          done();
          resolve(data);
        } else if (data.tag === tag) {
          // tag matched but the predicate rejected — keep waiting
          logger.debug(`Tag '${tag}' matched but predicate rejected; continuing`);
        } else if (terminalTags.includes(data.tag)) {
          done();
          reject(new HydraTerminalError(data.tag, data));
        } else {
          logger.debug(`Ignoring ${data.tag} while waiting for ${tag}`);
        }
      } catch (err) {
        done();
        reject(err);
      }
    };
  });
}
