/**
 * Unit tests for the stdout-integrity helpers introduced in the MCP `-32000`
 * fix (RC1 defenses L2 + L4). The runtime tripwire is the on-shelf
 * replacement for the legacy `process.stdout.write =` reassignment in
 * embedder/reranker — it MUST be side-observe (forward unchanged) and
 * MUST NOT reroute writes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  assertStdoutPureDuring,
  installStdoutTripwire,
} from '../../src/adapters/stdout_guard.js';
import type { Logger } from '../../src/logging.js';

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

function fakeLogger(): { log: Logger; warns: Array<{ msg: string; extra?: unknown }> } {
  const warns: Array<{ msg: string; extra?: unknown }> = [];
  const log = {
    warn: (msg: string, extra?: Record<string, unknown>): void => {
      warns.push({ msg, extra });
    },
    info: (): void => {},
    debug: (): void => {},
    error: (): void => {},
    metric: (): void => {},
  } as unknown as Logger;
  return { log, warns };
}

describe('assertStdoutPureDuring', () => {
  it('captures stdout writes during fn and returns byte count + chunks', async () => {
    const out = await assertStdoutPureDuring(async () => {
      process.stdout.write('hello\n');
      process.stdout.write(Buffer.from('world\n', 'utf8'));
      return 42;
    });
    expect(out.result).toBe(42);
    expect(out.bytesWritten).toBe(12);
    expect(out.chunks).toEqual(['hello\n', 'world\n']);
  });

  it('restores process.stdout.write even when fn throws', async () => {
    const original = process.stdout.write;
    await expect(
      assertStdoutPureDuring(async () => {
        process.stdout.write('partial');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(process.stdout.write).toBe(original);
  });
});

describe('installStdoutTripwire', () => {
  it('forwards every chunk to the real stdout AND warns on non-JSON-RPC bytes', () => {
    const { log, warns } = fakeLogger();
    const seen: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // Wrap the real stdout so the test can observe what the tripwire
    // forwards (without actually polluting the test runner's stdout).
    process.stdout.write = ((chunk: unknown): boolean => {
      if (typeof chunk === 'string') seen.push(chunk);
      else if (chunk instanceof Uint8Array) seen.push(Buffer.from(chunk).toString('utf8'));
      return true;
    }) as NodeJS.WriteStream['write'];
    try {
      restore = installStdoutTripwire(log);
      process.stdout.write('{"jsonrpc":"2.0","id":1}\n');
      process.stdout.write('rogue diagnostic from a misbehaving library');
      // Both writes MUST have been forwarded to the inner stdout shim.
      expect(seen).toEqual([
        '{"jsonrpc":"2.0","id":1}\n',
        'rogue diagnostic from a misbehaving library',
      ]);
      // Only the non-`{` chunk triggers a warn.
      expect(warns).toHaveLength(1);
      expect(warns[0].msg).toBe('stdout_tripwire_byte');
      expect((warns[0].extra as { preview: string }).preview).toContain('rogue diagnostic');
    } finally {
      // Restore must be done in reverse install order: tripwire uninstall
      // first (resets back to the shim), then the shim itself.
      restore?.();
      restore = null;
      process.stdout.write = origWrite;
    }
  });

  it('returned uninstaller restores the original write', () => {
    const { log } = fakeLogger();
    const before = process.stdout.write;
    const uninstall = installStdoutTripwire(log);
    expect(process.stdout.write).not.toBe(before);
    uninstall();
    expect(process.stdout.write).toBe(before);
  });

  it('treats a leading newline as valid JSON-RPC (some clients pad with \\n)', () => {
    const { log, warns } = fakeLogger();
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((): boolean => true) as NodeJS.WriteStream['write'];
    try {
      restore = installStdoutTripwire(log);
      process.stdout.write('\n{"jsonrpc":"2.0"}');
      expect(warns).toHaveLength(0);
    } finally {
      restore?.();
      restore = null;
      process.stdout.write = origWrite;
    }
  });
});

describe('installStdoutTripwire — integration with vi.fn for log', () => {
  it('does NOT reroute writes (anti-regression for the RC1 bug)', () => {
    const warnSpy = vi.fn();
    const log = { warn: warnSpy, info: vi.fn(), debug: vi.fn(), error: vi.fn(), metric: vi.fn() } as unknown as Logger;
    let forwarded = 0;
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((): boolean => {
      forwarded++;
      return true;
    }) as NodeJS.WriteStream['write'];
    try {
      restore = installStdoutTripwire(log);
      process.stdout.write('{"jsonrpc":"2.0"}');
      expect(forwarded, 'tripwire must forward to the real stdout, never reroute').toBe(1);
    } finally {
      restore?.();
      restore = null;
      process.stdout.write = origWrite;
    }
  });
});
