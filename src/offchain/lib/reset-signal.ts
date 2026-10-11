import { promises as fs } from 'fs';
import path from 'path';

/**
 * Atomically drop a reset marker the hydra-reset sidecar watches: write a temp file then rename it
 * into place (rename is atomic on one filesystem) so the sidecar never reads a partial marker. The
 * temp name (.<id>.reset.tmp) is excluded by the sidecar's *.reset glob. Named by processId for
 * idempotency. Returns the final marker path.
 */
export async function writeResetMarker(
  dir: string,
  processId: string,
  reason: string
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${processId}.reset`);
  const tmpPath = path.join(dir, `.${processId}.reset.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify({ processId, reason }), 'utf8');
  await fs.rename(tmpPath, finalPath);
  return finalPath;
}
