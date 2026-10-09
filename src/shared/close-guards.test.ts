import { describe, it, expect } from 'vitest';
import {
  assertCloseable,
  ProcessNotFoundError,
  CloseInProgressError,
} from './close-guards';
import { DBStatus } from './prisma-schemas';

describe('assertCloseable', () => {
  it('throws ProcessNotFoundError for a missing process', () => {
    expect(() => assertCloseable(null, 'abc')).toThrow(ProcessNotFoundError);
  });

  it('throws CloseInProgressError when already DECOMMITING', () => {
    expect(() => assertCloseable({ status: DBStatus.DECOMMITING }, 'abc')).toThrow(
      CloseInProgressError
    );
  });

  it('throws CloseInProgressError when already CLOSING', () => {
    expect(() => assertCloseable({ status: DBStatus.CLOSING }, 'abc')).toThrow(
      CloseInProgressError
    );
  });

  it('allows a RUNNING head', () => {
    expect(() => assertCloseable({ status: DBStatus.RUNNING }, 'abc')).not.toThrow();
  });

  it('allows a FAILED head (cleanup path)', () => {
    expect(() => assertCloseable({ status: DBStatus.FAILED }, 'abc')).not.toThrow();
  });
});

import { assertRunning, NotRunningError } from './close-guards';

describe('assertRunning', () => {
  it('passes when a head is RUNNING', () => {
    expect(() => assertRunning({ status: DBStatus.RUNNING })).not.toThrow();
  });
  it('throws NotRunningError when there is no active head', () => {
    expect(() => assertRunning(null)).toThrow(NotRunningError);
  });
  it('throws NotRunningError mid-close (DECOMMITING/CLOSING)', () => {
    expect(() => assertRunning({ status: DBStatus.DECOMMITING })).toThrow(NotRunningError);
    expect(() => assertRunning({ status: DBStatus.CLOSING })).toThrow(NotRunningError);
  });
});
