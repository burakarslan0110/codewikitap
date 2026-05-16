/**
 * Unit tests for heap-cap re-exec decision logic.
 *
 * The decision is pure: it takes an env snapshot + execArgv and returns
 * whether the bin entry should re-exec itself with --max-old-space-size.
 * Integration scenarios (actual spawn) live in
 * tests/integration/heap_cap.integration.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

import {
  shouldReexecForHeapCap,
  reexecWithHeapCap,
  isHeapCapShutdownMessage,
} from '../../src/heap_cap.js';

describe('shouldReexecForHeapCap', () => {
  it('returns reexec=true when no flag, no sentinel, no opt-out', () => {
    const d = shouldReexecForHeapCap({ env: {}, execArgv: [] });
    expect(d.reexec).toBe(true);
    expect(d.reason).toBe('needs-cap');
  });

  it('honors the CODEWIKI_HEAP_CAP_APPLIED sentinel (fork-bomb guard)', () => {
    const d = shouldReexecForHeapCap({
      env: { CODEWIKI_HEAP_CAP_APPLIED: '1' },
      execArgv: [],
    });
    expect(d.reexec).toBe(false);
    expect(d.reason).toBe('sentinel');
  });

  it('honors CODEWIKI_DISABLE_HEAP_CAP=1 (opt-out)', () => {
    const d = shouldReexecForHeapCap({
      env: { CODEWIKI_DISABLE_HEAP_CAP: '1' },
      execArgv: [],
    });
    expect(d.reexec).toBe(false);
    expect(d.reason).toBe('disabled');
  });

  it('idempotent when execArgv already has --max-old-space-size=...', () => {
    const d = shouldReexecForHeapCap({
      env: {},
      execArgv: ['--max-old-space-size=2048'],
    });
    expect(d.reexec).toBe(false);
    expect(d.reason).toBe('already-set');
  });

  it('also matches --max-old-space-size as separate flag + value', () => {
    const d = shouldReexecForHeapCap({
      env: {},
      execArgv: ['--max-old-space-size', '2048'],
    });
    expect(d.reexec).toBe(false);
    expect(d.reason).toBe('already-set');
  });

  it('sentinel beats execArgv mismatch (sentinel guard is primary)', () => {
    // A launcher that strips execArgv but inherits env should still skip.
    const d = shouldReexecForHeapCap({
      env: { CODEWIKI_HEAP_CAP_APPLIED: '1' },
      execArgv: [],
    });
    expect(d.reexec).toBe(false);
    expect(d.reason).toBe('sentinel');
  });

  it('disable beats execArgv mismatch (opt-out wins)', () => {
    const d = shouldReexecForHeapCap({
      env: { CODEWIKI_DISABLE_HEAP_CAP: '1' },
      execArgv: [],
    });
    expect(d.reexec).toBe(false);
    expect(d.reason).toBe('disabled');
  });
});

describe('isHeapCapShutdownMessage', () => {
  it('matches the wire shape', () => {
    expect(isHeapCapShutdownMessage({ type: 'codewiki-shutdown', signal: 'SIGTERM' })).toBe(true);
    expect(isHeapCapShutdownMessage({ type: 'codewiki-shutdown', signal: 'SIGINT' })).toBe(true);
  });

  it('rejects malformed payloads', () => {
    expect(isHeapCapShutdownMessage(null)).toBe(false);
    expect(isHeapCapShutdownMessage(undefined)).toBe(false);
    expect(isHeapCapShutdownMessage('codewiki-shutdown')).toBe(false);
    expect(isHeapCapShutdownMessage({ type: 'other', signal: 'SIGTERM' })).toBe(false);
    expect(isHeapCapShutdownMessage({ type: 'codewiki-shutdown' })).toBe(false);
    expect(isHeapCapShutdownMessage({ type: 'codewiki-shutdown', signal: 42 })).toBe(false);
  });
});

describe('reexecWithHeapCap — Windows graceful shutdown via IPC', () => {
  function makeFakeChild(): { child: ChildProcess; calls: { sendArgs: unknown[]; killArgs: unknown[]; onArgs: unknown[][] } } {
    const calls = { sendArgs: [] as unknown[], killArgs: [] as unknown[], onArgs: [] as unknown[][] };
    const child = {
      on: vi.fn((event: string, handler: unknown) => { calls.onArgs.push([event, handler]); return child; }),
      kill: vi.fn((sig?: unknown) => { calls.killArgs.push(sig); return true; }),
      send: vi.fn((msg: unknown) => { calls.sendArgs.push(msg); return true; }),
    } as unknown as ChildProcess;
    return { child, calls };
  }

  it('on Windows: opens an IPC channel (stdio[3] === "ipc") and only forwards SIGTERM + SIGINT (no SIGHUP)', () => {
    const { child, calls } = makeFakeChild();
    let observedStdio: SpawnOptions['stdio'] | undefined;
    const registeredSignals: NodeJS.Signals[] = [];

    reexecWithHeapCap({
      execPath: '/usr/bin/node',
      execArgv: [],
      argv: ['/usr/bin/node', '/app/dist/index.js'],
      env: {},
      heapMb: 1536,
      platformOverride: 'win32',
      spawnImpl: (_cmd, _args, opts) => {
        observedStdio = opts.stdio;
        return child;
      },
      onSignal: (sig) => { registeredSignals.push(sig); },
      exitImpl: ((_code: number): never => { throw new Error('exit should not run in this test'); }),
    });

    expect(observedStdio).toEqual(['inherit', 'inherit', 'inherit', 'ipc']);
    expect(registeredSignals.sort()).toEqual(['SIGINT', 'SIGTERM']);
    // child.on('exit', ...) is wired but the handler hasn't fired.
    expect(calls.onArgs.some(([ev]) => ev === 'exit')).toBe(true);
  });

  it('on Windows: SIGTERM handler sends IPC message instead of killing the child abruptly', () => {
    const { child, calls } = makeFakeChild();
    const handlers = new Map<NodeJS.Signals, () => void>();

    reexecWithHeapCap({
      execPath: '/usr/bin/node',
      execArgv: [],
      argv: ['/usr/bin/node', '/app/dist/index.js'],
      env: {},
      heapMb: 1536,
      platformOverride: 'win32',
      ipcGraceMs: 50,
      spawnImpl: () => child,
      onSignal: (sig, handler) => { handlers.set(sig, handler); },
      exitImpl: ((_code: number): never => { throw new Error('exit should not run'); }),
    });

    // Simulate SIGTERM arriving at the wrapper.
    handlers.get('SIGTERM')!();

    // Must send IPC, NOT call child.kill(sig).
    expect(calls.sendArgs).toHaveLength(1);
    expect(calls.sendArgs[0]).toEqual({ type: 'codewiki-shutdown', signal: 'SIGTERM' });
    expect(calls.killArgs).toHaveLength(0);
  });

  it('on POSIX: NO IPC channel; signals are forwarded via child.kill(sig); SIGHUP is registered', () => {
    const { child, calls } = makeFakeChild();
    let observedStdio: SpawnOptions['stdio'] | undefined;
    const handlers = new Map<NodeJS.Signals, () => void>();

    reexecWithHeapCap({
      execPath: '/usr/bin/node',
      execArgv: [],
      argv: ['/usr/bin/node', '/app/dist/index.js'],
      env: {},
      heapMb: 1536,
      platformOverride: 'linux',
      spawnImpl: (_cmd, _args, opts) => { observedStdio = opts.stdio; return child; },
      onSignal: (sig, handler) => { handlers.set(sig, handler); },
      exitImpl: ((_code: number): never => { throw new Error('exit should not run'); }),
    });

    expect(observedStdio).toBe('inherit');
    expect([...handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);

    handlers.get('SIGTERM')!();
    expect(calls.sendArgs).toHaveLength(0);
    expect(calls.killArgs).toEqual(['SIGTERM']);
  });
});
