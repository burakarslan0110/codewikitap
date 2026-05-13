import { describe, it, expect } from 'vitest';

import { assertNodeVersion, MIN_NODE_MAJOR } from '../../src/runtime_check.js';

interface Captured {
  readonly chunks: string[];
  readonly exitCode: number | null;
}

class ExitSentinel extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit(${code})`);
    this.code = code;
  }
}

function makeCaptured(): Captured & {
  readonly stderrWrite: (chunk: string) => void;
  readonly exit: (code: number) => never;
} {
  const chunks: string[] = [];
  let exitCode: number | null = null;
  const state = { chunks, get exitCode() { return exitCode; } };
  const stderrWrite = (chunk: string): void => { chunks.push(chunk); };
  const exit = (code: number): never => {
    exitCode = code;
    throw new ExitSentinel(code);
  };
  return Object.assign(state, { stderrWrite, exit });
}

function makeVersions(node: string): NodeJS.ProcessVersions {
  return { node, v8: '12.0', uv: '1.0', zlib: '1.0', brotli: '1.0', ares: '1.0', modules: '0', nghttp2: '1.0', napi: '0', llhttp: '1.0', openssl: '1.0', cldr: '1.0', icu: '1.0', tz: '1.0', unicode: '1.0' } as unknown as NodeJS.ProcessVersions;
}

describe('runtime_check.assertNodeVersion', () => {
  it('exports MIN_NODE_MAJOR = 20', () => {
    expect(MIN_NODE_MAJOR).toBe(20);
  });

  it('silently passes on Node 20.18.1 (>= MIN_NODE_MAJOR)', () => {
    const cap = makeCaptured();
    expect(() => assertNodeVersion({
      versions: makeVersions('20.18.1'),
      stderrWrite: cap.stderrWrite,
      exit: cap.exit,
    })).not.toThrow();
    expect(cap.chunks).toEqual([]);
    expect(cap.exitCode).toBeNull();
  });

  it('silently passes on Node 22.5.0 + 24.15.0 (well above min)', () => {
    for (const v of ['22.5.0', '24.15.0']) {
      const cap = makeCaptured();
      expect(() => assertNodeVersion({
        versions: makeVersions(v),
        stderrWrite: cap.stderrWrite,
        exit: cap.exit,
      })).not.toThrow();
      expect(cap.chunks).toEqual([]);
      expect(cap.exitCode).toBeNull();
    }
  });

  it('writes recovery message and exits 1 on Node 18.19.0 (< MIN_NODE_MAJOR)', () => {
    const cap = makeCaptured();
    expect(() => assertNodeVersion({
      versions: makeVersions('18.19.0'),
      stderrWrite: cap.stderrWrite,
      exit: cap.exit,
    })).toThrow(ExitSentinel);
    expect(cap.exitCode).toBe(1);
    const message = cap.chunks.join('');
    expect(message).toContain('codewikitap requires Node.js >= 20');
    expect(message).toContain('18.19.0');
    expect(message).toContain('https://nodejs.org/');
  });

  it('writes recovery message and exits 1 on malformed versions.node', () => {
    const cap = makeCaptured();
    expect(() => assertNodeVersion({
      versions: makeVersions('not-a-version'),
      stderrWrite: cap.stderrWrite,
      exit: cap.exit,
    })).toThrow(ExitSentinel);
    expect(cap.exitCode).toBe(1);
    expect(cap.chunks.join('')).toContain('codewikitap requires Node.js >= 20');
  });
});
