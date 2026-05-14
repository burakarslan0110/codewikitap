import { describe, it, expect } from 'vitest';

import { detectRuntimeCapabilities, type RuntimeCapabilitiesDeps } from '../../src/runtime_capabilities.js';

interface CapturedLog {
  level: string;
  msg: string;
  [key: string]: unknown;
}

function makeLogger(): { calls: CapturedLog[]; log: RuntimeCapabilitiesDeps['log'] } {
  const calls: CapturedLog[] = [];
  const stub = {
    info: (msg: string, payload?: Record<string, unknown>): void => {
      calls.push({ level: 'info', msg, ...(payload ?? {}) });
    },
    debug: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    metric: (): void => undefined,
  };
  return { calls, log: stub as unknown as RuntimeCapabilitiesDeps['log'] };
}

describe('runtime_capabilities.detectRuntimeCapabilities', () => {
  it('emits exactly one info-level log line with the documented schema', () => {
    const { calls, log } = makeLogger();
    detectRuntimeCapabilities({
      cache: { isInMemory: false, vecAvailable: true },
      driver: { readyState: 'ready' },
      log,
      processSnapshot: { versions: { node: '22.5.0' }, platform: 'darwin', arch: 'arm64' } as never,
    });

    expect(calls).toHaveLength(1);
    const entry = calls[0]!;
    expect(entry.msg).toBe('runtime_capabilities');
    expect(entry.level).toBe('info');
    expect(entry.betterSqlite3).toBe(true);
    expect(entry.sqliteVec).toBe(true);
    expect(entry.playwright).toBe('ready');
    expect(entry.nodeVersion).toBe('22.5.0');
    expect(entry.platform).toBe('darwin');
    expect(entry.arch).toBe('arm64');
  });

  it('reports betterSqlite3=false when cache.isInMemory=true', () => {
    const { calls, log } = makeLogger();
    detectRuntimeCapabilities({
      cache: { isInMemory: true, vecAvailable: false },
      driver: { readyState: 'pending' },
      log,
      processSnapshot: { versions: { node: '22.5.0' }, platform: 'linux', arch: 'x64' } as never,
    });
    expect(calls[0]!.betterSqlite3).toBe(false);
    expect(calls[0]!.sqliteVec).toBe(false);
  });

  it('passes through playwright readyState verbatim (pending|ready|failed)', () => {
    for (const state of ['pending', 'ready', 'failed'] as const) {
      const { calls, log } = makeLogger();
      detectRuntimeCapabilities({
        cache: { isInMemory: false, vecAvailable: true },
        driver: { readyState: state },
        log,
        processSnapshot: { versions: { node: '22.5.0' }, platform: 'linux', arch: 'x64' } as never,
      });
      expect(calls[0]!.playwright).toBe(state);
    }
  });

  it('is synchronous — completes within the same tick', () => {
    const { calls, log } = makeLogger();
    const before = calls.length;
    detectRuntimeCapabilities({
      cache: { isInMemory: false, vecAvailable: true },
      driver: { readyState: 'ready' },
      log,
      processSnapshot: { versions: { node: '22.5.0' }, platform: 'linux', arch: 'x64' } as never,
    });
    expect(calls.length).toBe(before + 1);
  });
});
