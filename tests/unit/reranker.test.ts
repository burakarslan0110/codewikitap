/**
 * Reranker adapter unit tests — exercises the test-seam (constructor-injected
 * scorer) so the suite stays under 1 ms per case and never touches the real
 * @xenova/transformers cross-encoder model. Mirrors the embedder.test.ts
 * pattern; new for v2.6: download_timeout + single-flight + circuit breaker.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  Reranker,
  ScorerImpl,
  getReranker,
  resetRerankerForTesting,
} from '../../src/adapters/reranker.js';
import { RerankerError } from '../../src/types.js';

function mockScorer(): ScorerImpl {
  return {
    async score(query: string, candidates: string[]): Promise<number[]> {
      // Deterministic: score = candidate-text length minus query length;
      // longer candidates score higher than shorter. Used to verify ordering
      // not exact magnitude.
      return candidates.map((c) => c.length - query.length);
    },
  };
}

function failingScorer(kind: 'download_failed' | 'download_timeout' | 'score_failed'): ScorerImpl {
  return {
    async score(): Promise<number[]> {
      throw new RerankerError(kind, `mock ${kind}: model=Xenova/ms-marco-MiniLM-L-6-v2`);
    },
  };
}

beforeEach(() => {
  resetRerankerForTesting();
});

afterEach(() => {
  resetRerankerForTesting();
  vi.useRealTimers();
});

describe('Reranker — singleton', () => {
  it('getReranker returns the same instance across calls', async () => {
    const a = await getReranker({ scorerImpl: mockScorer() });
    const b = await getReranker({ scorerImpl: mockScorer() });
    expect(a).toBe(b);
  });
});

describe('Reranker — score', () => {
  it('returns one score per candidate', async () => {
    const r = await getReranker({ scorerImpl: mockScorer() });
    const out = await r.score('q', ['short', 'a longer candidate', 'medium one']);
    expect(out.length).toBe(3);
  });

  it('score("q", []) returns []', async () => {
    const r = await getReranker({ scorerImpl: mockScorer() });
    expect(await r.score('q', [])).toEqual([]);
  });

  it('throws RerankerError(download_failed) when scorer reports load failure', async () => {
    const r = await getReranker({ scorerImpl: failingScorer('download_failed') });
    await expect(r.score('q', ['x'])).rejects.toThrow(RerankerError);
    await expect(r.score('q', ['x'])).rejects.toMatchObject({
      kind: 'download_failed',
      message: expect.stringContaining('Xenova/ms-marco-MiniLM-L-6-v2'),
    });
  });

  it('throws RerankerError(score_failed) when inference fails', async () => {
    // Use direct constructor to bypass circuit-breaker singleton state.
    const r = new Reranker({ scorerImpl: failingScorer('score_failed') });
    await expect(r.score('q', ['x'])).rejects.toMatchObject({ kind: 'score_failed' });
  });
});

describe('Reranker — fingerprint', () => {
  it('getFingerprint returns the configured model id', async () => {
    const r = await getReranker({ modelName: 'my/cross-encoder', scorerImpl: mockScorer() });
    expect(r.getFingerprint()).toEqual({ model: 'my/cross-encoder' });
  });
});

describe('Reranker — single-flight load', () => {
  it('concurrent first-callers share the same in-flight load promise', async () => {
    // Build a scorer factory that captures the number of resolutions.
    let resolveLoad: (s: ScorerImpl) => void = () => undefined;
    const loadPromise = new Promise<ScorerImpl>((resolve) => {
      resolveLoad = resolve;
    });
    let loadCalls = 0;
    const r = new Reranker({
      // Inject NO scorer here so the lazy load path fires. We mock the
      // underlying load by overriding the protected method via subclass.
      // Simpler: use the documented test seam — pass a `scorerLoader`
      // function instead of an instance.
      scorerLoader: () => {
        loadCalls += 1;
        return loadPromise;
      },
    });

    // Fire three concurrent score calls before resolving the load.
    const p1 = r.score('q', ['a']);
    const p2 = r.score('q', ['b']);
    const p3 = r.score('q', ['c']);

    // Resolve the single load promise.
    resolveLoad(mockScorer());
    await Promise.all([p1, p2, p3]);
    expect(loadCalls).toBe(1);
  });
});

describe('Reranker — download timeout', () => {
  it('throws RerankerError(download_timeout) when load exceeds RERANK_DOWNLOAD_TIMEOUT_MS', async () => {
    // A loader that never resolves — exercises the bounded race.
    const r = new Reranker({
      scorerLoader: () => new Promise<ScorerImpl>(() => { /* never resolves */ }),
      downloadTimeoutMs: 50, // tight bound for the test
    });
    await expect(r.score('q', ['x'])).rejects.toMatchObject({ kind: 'download_timeout' });
  });
});

describe('Reranker — circuit breaker', () => {
  it('within the breaker window, repeated calls re-throw the cached error WITHOUT re-attempting load', async () => {
    let loadCalls = 0;
    const r = new Reranker({
      scorerLoader: async () => {
        loadCalls += 1;
        throw new RerankerError('download_failed', 'mock first failure');
      },
      circuitBreakerMs: 60000,
    });

    await expect(r.score('q', ['x'])).rejects.toMatchObject({ kind: 'download_failed' });
    await expect(r.score('q', ['x'])).rejects.toMatchObject({ kind: 'download_failed' });
    await expect(r.score('q', ['x'])).rejects.toMatchObject({ kind: 'download_failed' });
    expect(loadCalls).toBe(1);
  });

  it('after the breaker window expires, the next call retries the load', async () => {
    let loadCalls = 0;
    let shouldFail = true;
    const r = new Reranker({
      scorerLoader: async () => {
        loadCalls += 1;
        if (shouldFail) throw new RerankerError('download_failed', 'mock first failure');
        return mockScorer();
      },
      circuitBreakerMs: 100,
    });

    await expect(r.score('q', ['x'])).rejects.toMatchObject({ kind: 'download_failed' });
    expect(loadCalls).toBe(1);

    // Wait past the breaker window.
    await new Promise((resolve) => setTimeout(resolve, 120));
    shouldFail = false;

    const out = await r.score('q', ['hello']);
    expect(out.length).toBe(1);
    expect(loadCalls).toBe(2);
  });
});

describe('Reranker — stdio safety', () => {
  it('score() does not write to process.stdout', async () => {
    const r = await getReranker({ scorerImpl: mockScorer() });
    const captured: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (chunk: string | Buffer) => boolean) = (chunk: string | Buffer): boolean => {
      captured.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return true;
    };
    try {
      await r.score('q', ['hello', 'world']);
    } finally {
      process.stdout.write = originalWrite;
    }
    const totalBytes = captured.reduce((n, b) => n + b.length, 0);
    expect(totalBytes).toBe(0);
  });
});

describe('Reranker — direct constructor', () => {
  it('class can be constructed directly bypassing the singleton (test seam)', async () => {
    const r = new Reranker({ scorerImpl: mockScorer() });
    const out = await r.score('q', ['x']);
    expect(out.length).toBe(1);
  });
});
