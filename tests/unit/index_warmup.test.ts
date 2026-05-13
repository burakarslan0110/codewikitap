/**
 * Unit tests for `warmupModels` (src/index.ts) — RC1 defense L3.
 *
 * The warmup is the runtime perf optimization that takes the place of the
 * deleted stdout-wrap. Failures MUST NOT escape — they only emit a warn-log.
 * The `CODEWIKI_DISABLE_MODEL_WARMUP=1` skip path emits an `info` log only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { Embedder, EncoderImpl } from '../../src/adapters/embedder.js';
import { Reranker, ScorerImpl } from '../../src/adapters/reranker.js';
import { EmbedderError, RerankerError } from '../../src/types.js';
import type { Logger } from '../../src/logging.js';

function mockEncoder(): EncoderImpl {
  return {
    encode: vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(8))),
  };
}

function failingEncoder(): EncoderImpl {
  return {
    encode: vi.fn(async () => {
      throw new EmbedderError('download_failed', 'mock encoder failure');
    }),
  };
}

function mockScorer(): ScorerImpl {
  return {
    score: vi.fn(async (_q: string, candidates: string[]) => candidates.map(() => 0.5)),
  };
}

function failingScorer(): ScorerImpl {
  return {
    score: vi.fn(async () => {
      throw new RerankerError('download_failed', 'mock scorer failure');
    }),
  };
}

interface FakeLogger {
  log: Logger;
  infos: Array<{ msg: string; extra?: unknown }>;
  warns: Array<{ msg: string; extra?: unknown }>;
}

function fakeLogger(): FakeLogger {
  const infos: Array<{ msg: string; extra?: unknown }> = [];
  const warns: Array<{ msg: string; extra?: unknown }> = [];
  const log = {
    info: (msg: string, extra?: Record<string, unknown>): void => {
      infos.push({ msg, extra });
    },
    warn: (msg: string, extra?: Record<string, unknown>): void => {
      warns.push({ msg, extra });
    },
    debug: (): void => {},
    error: (): void => {},
    metric: (): void => {},
  } as unknown as Logger;
  return { log, infos, warns };
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.CODEWIKI_DISABLE_MODEL_WARMUP;
});

afterEach(() => {
  vi.resetModules();
  delete process.env.CODEWIKI_DISABLE_MODEL_WARMUP;
});

describe('warmupModels', () => {
  it('encodes the warmup string with the embedder and scores it with the reranker', async () => {
    const embedder = new Embedder({ modelDim: 8, encoderImpl: mockEncoder() });
    const reranker = new Reranker({ scorerImpl: mockScorer() });
    const { log, infos, warns } = fakeLogger();
    const { warmupModels } = await import('../../src/index.js');

    await warmupModels({ embedder, reranker, log });

    expect(warns).toHaveLength(0);
    // `embedder.load.start` / `reranker.load.start` fire from the REAL
    // default loaders; this test injects mocks via `encoderImpl` /
    // `scorerImpl`, so we only see the four warmup wrapper messages.
    expect(infos.map((i) => i.msg)).toEqual([
      'warmup.embedder.started',
      'warmup.embedder.done',
      'warmup.reranker.started',
      'warmup.reranker.done',
    ]);
  });

  it('swallows embedder errors as a warmup_failed warn and proceeds to the reranker', async () => {
    const embedder = new Embedder({ modelDim: 8, encoderImpl: failingEncoder() });
    const reranker = new Reranker({ scorerImpl: mockScorer() });
    const { log, infos, warns } = fakeLogger();
    const { warmupModels } = await import('../../src/index.js');

    await warmupModels({ embedder, reranker, log });

    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toBe('warmup_failed');
    expect((warns[0].extra as { model: string }).model).toBe('embedder');
    expect(infos.map((i) => i.msg)).toContain('warmup.reranker.started');
    expect(infos.map((i) => i.msg)).toContain('warmup.reranker.done');
  });

  it('swallows reranker errors as a warmup_failed warn', async () => {
    const embedder = new Embedder({ modelDim: 8, encoderImpl: mockEncoder() });
    const reranker = new Reranker({ scorerImpl: failingScorer() });
    const { log, warns } = fakeLogger();
    const { warmupModels } = await import('../../src/index.js');

    await warmupModels({ embedder, reranker, log });

    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toBe('warmup_failed');
    expect((warns[0].extra as { model: string }).model).toBe('reranker');
  });

  it('skips entirely when CODEWIKI_DISABLE_MODEL_WARMUP=1', async () => {
    process.env.CODEWIKI_DISABLE_MODEL_WARMUP = '1';
    const embedderEncode = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array(8)),
    );
    const scorerScore = vi.fn(async (_q: string, candidates: string[]) =>
      candidates.map(() => 0.5),
    );
    const embedder = new Embedder({ modelDim: 8, encoderImpl: { encode: embedderEncode } });
    const reranker = new Reranker({ scorerImpl: { score: scorerScore } });
    const { log, infos, warns } = fakeLogger();
    const { warmupModels } = await import('../../src/index.js');

    await warmupModels({ embedder, reranker, log });

    expect(embedderEncode).not.toHaveBeenCalled();
    expect(scorerScore).not.toHaveBeenCalled();
    expect(warns).toHaveLength(0);
    expect(infos).toHaveLength(1);
    expect(infos[0].msg).toBe('warmup_skipped');
  });
});
