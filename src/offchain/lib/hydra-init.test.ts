import { describe, it, expect, vi } from 'vitest';
import { performInit, InitDeps } from './hydra-init';
import { HydraTerminalError, HydraInitError } from './hydra-messages';

function deps(over: Partial<InitDeps> = {}): InitDeps {
  return {
    headIsOpen: vi.fn().mockResolvedValue(false),
    sendInit: vi.fn(),
    awaitHeadIsOpen: vi.fn().mockResolvedValue({ tag: 'HeadIsOpen' }),
    ...over,
  };
}

describe('performInit', () => {
  it('skips Init when the head is already open', async () => {
    const d = deps({ headIsOpen: vi.fn().mockResolvedValue(true) });
    const r = await performInit(d);
    expect(r).toEqual({ outcome: 'skipped-already-open' });
    expect(d.sendInit).not.toHaveBeenCalled();
  });

  it('opens when idle then HeadIsOpen arrives', async () => {
    const d = deps({
      awaitHeadIsOpen: vi.fn().mockResolvedValue({ tag: 'HeadIsOpen', headId: 'h1' }),
    });
    const r = await performInit(d);
    expect(d.sendInit).toHaveBeenCalledOnce();
    expect(r).toMatchObject({ outcome: 'opened', payload: { headId: 'h1' } });
  });

  it('treats CommandFailed as a no-op race when the head is open afterwards', async () => {
    const headIsOpen = vi
      .fn()
      .mockResolvedValueOnce(false) // probe before Init
      .mockResolvedValueOnce(true); // re-probe after CommandFailed
    const d = deps({
      headIsOpen,
      awaitHeadIsOpen: vi
        .fn()
        .mockRejectedValue(new HydraTerminalError('CommandFailed', { tag: 'CommandFailed' })),
    });
    const r = await performInit(d);
    expect(r).toMatchObject({ outcome: 'noop-race' });
  });

  it('throws HydraInitError on CommandFailed when the head is not open', async () => {
    const headIsOpen = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    const d = deps({
      headIsOpen,
      awaitHeadIsOpen: vi
        .fn()
        .mockRejectedValue(new HydraTerminalError('CommandFailed', { tag: 'CommandFailed' })),
    });
    await expect(performInit(d)).rejects.toBeInstanceOf(HydraInitError);
  });

  it('propagates PostTxOnChainFailed unchanged', async () => {
    const d = deps({
      awaitHeadIsOpen: vi
        .fn()
        .mockRejectedValue(new HydraTerminalError('PostTxOnChainFailed', {})),
    });
    await expect(performInit(d)).rejects.toBeInstanceOf(HydraTerminalError);
  });
});
