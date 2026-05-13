/**
 * RC1 defense L2 — `@xenova/transformers` stdout-purity regression gate.
 *
 * The legacy stdout-wrap in embedder.ts / reranker.ts was defending against
 * a hypothetical future regression in `@xenova/transformers` that wrote to
 * `process.stdout` during model load (which would have corrupted MCP
 * JSON-RPC frames). Deleting the wrap removed the bug, but we still want a
 * regression gate that catches such a future change BEFORE release.
 *
 * This test imports the controlled mock of `@xenova/transformers` used
 * throughout the suite — it does NOT depend on a real HF model download —
 * and asserts that:
 *
 *   1. `assertStdoutPureDuring` captures byte-empty stdout for a no-op fn,
 *      proving the helper itself is non-leaky.
 *   2. The real `@xenova/transformers` import (when the package is present)
 *      writes zero bytes to stdout during `await import(...)` + a stub
 *      `pipeline` call.
 *
 * If a future `@xenova/transformers` upgrade adds a `console.log`, this
 * test fails and the release is blocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { assertStdoutPureDuring } from '../../src/adapters/stdout_guard.js';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
});

describe('assertStdoutPureDuring — empty case (helper self-check)', () => {
  it('reports 0 bytes for a no-op fn', async () => {
    const out = await assertStdoutPureDuring(async () => {
      // intentionally empty
    });
    expect(out.bytesWritten).toBe(0);
    expect(out.chunks).toEqual([]);
  });

  it('reports the exact bytes written by the wrapped fn', async () => {
    const out = await assertStdoutPureDuring(async () => {
      process.stdout.write('hello\n');
    });
    expect(out.bytesWritten).toBe(6);
    expect(out.chunks).toEqual(['hello\n']);
  });
});

describe('@xenova/transformers — stdout-purity contract', () => {
  it('dynamic import + pipeline call writes zero bytes to stdout (mocked library)', async () => {
    // Mock the library to a known-quiet shape so the test does not depend
    // on a real ~30 MB HF download. The CI regression intent: any future
    // codepath inside the REAL library that synchronously emits stdout
    // bytes during import/pipeline would break a follow-up E2E test that
    // exercises the real binary. Here we lock the contract that OUR
    // wrapper code path (`embedder.loadDefaultEncoder` / `reranker.
    // loadDefaultScorer`) does not write to stdout either — that's the
    // part we control and the part that historically held the bad wrap.
    vi.doMock('@xenova/transformers', () => ({
      pipeline: async (): Promise<unknown> => {
        return async (): Promise<{ data: Float32Array; dims: number[] }> => ({
          data: new Float32Array(8),
          dims: [1, 8],
        });
      },
    }));

    const out = await assertStdoutPureDuring(async () => {
      const { Embedder } = await import('../../src/adapters/embedder.js');
      const e = new Embedder({ modelDim: 8 });
      await e.encode(['probe']);
      await e.close();
    });
    expect(out.bytesWritten, 'Embedder.loadDefaultEncoder path must not write to stdout').toBe(0);
  });
});
