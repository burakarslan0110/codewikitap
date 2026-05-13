/**
 * Unit tests for `runInstall` (src/index.ts) — RC2 defense L7.
 *
 * The bug: `runInstall` had no timeout. A stalled `npx playwright install`
 * could leave the `playwrightReady` promise pending for minutes, surfacing
 * `playwright_unavailable`-rooted retry envelopes forever.
 *
 * The fix: bound the install with a wallclock timeout that kills the child
 * with SIGTERM and rejects the promise with a clear error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
}

function makeFakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter();
  c.killed = false;
  c.kill = vi.fn((_signal?: NodeJS.Signals) => {
    c.killed = true;
    return true;
  });
  return c;
}

let lastChild: FakeChild | null = null;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    lastChild = makeFakeChild();
    return lastChild;
  }),
}));

beforeEach(() => {
  lastChild = null;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe('runInstall — wallclock timeout (RC2 L7)', () => {
  it('rejects with a clear error when the install exceeds the timeout', async () => {
    const { runInstall } = await import('../../src/index.js');
    const p = runInstall(50); // 50 ms cap
    await expect(p).rejects.toThrow(/playwright install timed out after 50ms/);
  });

  it('SIGTERMs the child process on timeout', async () => {
    const { runInstall } = await import('../../src/index.js');
    const p = runInstall(50);
    await expect(p).rejects.toThrow();
    expect(lastChild?.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('resolves cleanly when the child exits with code 0 before the timeout', async () => {
    const { runInstall } = await import('../../src/index.js');
    const p = runInstall(5000);
    // Fire the exit event in the next macrotask to mimic real subprocess timing.
    setTimeout(() => {
      lastChild?.emit('exit', 0);
    }, 5);
    await expect(p).resolves.toBeUndefined();
    expect(lastChild?.kill).not.toHaveBeenCalled();
  });

  it('rejects with the exit code when the child exits non-zero before the timeout', async () => {
    const { runInstall } = await import('../../src/index.js');
    const p = runInstall(5000);
    setTimeout(() => {
      lastChild?.emit('exit', 137);
    }, 5);
    await expect(p).rejects.toThrow(/exited with code 137/);
  });

  it('rejects on child error before the timeout and never kills', async () => {
    const { runInstall } = await import('../../src/index.js');
    const p = runInstall(5000);
    setTimeout(() => {
      lastChild?.emit('error', new Error('spawn ENOENT'));
    }, 5);
    await expect(p).rejects.toThrow(/spawn ENOENT/);
    expect(lastChild?.kill).not.toHaveBeenCalled();
  });
});
