import { DBStatus } from './prisma-schemas';

/** No process row exists for the given id (prevents fabricating a phantom row on close). */
export class ProcessNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No process found for id ${id}`);
    this.name = 'ProcessNotFoundError';
  }
}

/** A close is already running for this process. */
export class CloseInProgressError extends Error {
  constructor(public readonly status: string) {
    super(`Close already in progress (status ${status})`);
    this.name = 'CloseInProgressError';
  }
}

/** States for which a fresh close must be rejected because one is already underway. */
const CLOSE_IN_PROGRESS: string[] = [DBStatus.DECOMMITING, DBStatus.CLOSING];

/**
 * Guard for POST /close-head. Throws ProcessNotFoundError for an unknown id (so the upsert in
 * updateHeadStatus cannot fabricate a phantom DECOMMITING row) and CloseInProgressError when a
 * close is already running. Every other status — including FAILED — is closeable; FAILED is the
 * cleanup path for a head that opened but failed funding.
 */
export function assertCloseable(
  process: { status: string } | null,
  id: string
): void {
  if (!process) throw new ProcessNotFoundError(id);
  if (CLOSE_IN_PROGRESS.includes(process.status)) {
    throw new CloseInProgressError(process.status);
  }
}
