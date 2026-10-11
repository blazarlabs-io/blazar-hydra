import { HydraTerminalError, HydraInitError } from './hydra-messages';
import { logger } from '../../shared/logger';

export interface InitDeps {
  /** Authoritative probe: true iff the node reports an open head (GET /snapshot/utxo == 200). */
  headIsOpen: () => Promise<boolean>;
  /** Send {tag:'Init'} on the socket. */
  sendInit: () => void;
  /** Await the HeadIsOpen ServerOutput; rejects via HydraTerminalError on a terminal tag. */
  awaitHeadIsOpen: () => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type InitOutcome =
  | { outcome: 'skipped-already-open' }
  | { outcome: 'opened'; payload: any } // eslint-disable-line @typescript-eslint/no-explicit-any
  | { outcome: 'noop-race'; payload: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Drive an idempotent Init. A CommandFailed is treated as a no-op ONLY when the node confirms the
 * head is actually open (re-probed after the failure); otherwise it surfaces as HydraInitError so a
 * real Init rejection cannot masquerade as success. PostTxOnChainFailed / timeouts propagate.
 */
export async function performInit(deps: InitDeps): Promise<InitOutcome> {
  if (await deps.headIsOpen()) {
    logger.info('Head already open; skipping Init (no-op)');
    return { outcome: 'skipped-already-open' };
  }
  logger.debug('Sending Init; awaiting HeadIsOpen...');
  deps.sendInit();
  try {
    const payload = await deps.awaitHeadIsOpen();
    return { outcome: 'opened', payload };
  } catch (err) {
    if (err instanceof HydraTerminalError && err.tag === 'CommandFailed') {
      if (await deps.headIsOpen()) {
        logger.info('Init returned CommandFailed but head is open — treating as no-op');
        return { outcome: 'noop-race', payload: err.payload };
      }
      logger.error('Init rejected (CommandFailed) and head is not open');
      throw new HydraInitError(err.payload);
    }
    throw err;
  }
}
