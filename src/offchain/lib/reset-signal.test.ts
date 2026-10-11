import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { writeResetMarker } from './reset-signal';

describe('writeResetMarker', () => {
  it('atomically writes <processId>.reset with no leftover temp file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-signal-'));
    const out = await writeResetMarker(dir, 'abc-123', 'fanout-after-decommit');
    expect(out).toBe(path.join(dir, 'abc-123.reset'));
    const body = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(body.processId).toBe('abc-123');
    expect(body.reason).toBe('fanout-after-decommit');
    expect(await fs.readdir(dir)).toEqual(['abc-123.reset']); // temp renamed away
  });
});
