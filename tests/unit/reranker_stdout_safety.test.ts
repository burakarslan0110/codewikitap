/**
 * RED test for the MCP `-32000` reconnect bug — RC1 / reranker leg.
 *
 * Mirrors `embedder_stdout_safety.test.ts`. The reranker lazy-loads
 * `@xenova/transformers` on first score(). Today
 * (src/adapters/reranker.ts:232-240) the loader globally replaces
 * `process.stdout.write` with a stderr-redirect for the entire async load.
 * Any CONCURRENT JSON-RPC frame written by the MCP SDK during the load is
 * silently rerouted to stderr → client times out → -32000.
 *
 * Status BEFORE the fix: FAILS — concurrent frame lands on stderr.
 * Status AFTER the fix: PASSES — wrap is deleted, frame lands on stdout.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { Reranker, resetRerankerForTesting } from '../../src/adapters/reranker.js';

const FRAME = '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}\n';

interface StreamRecorder {
  stdoutChunks: string[];
  stderrChunks: string[];
  restore: () => void;
}

function installRecorder(): StreamRecorder {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown): boolean => {
    if (typeof chunk === 'string') stdoutChunks.push(chunk);
    else if (chunk instanceof Uint8Array) stdoutChunks.push(Buffer.from(chunk).toString('utf8'));
    return true;
  }) as NodeJS.WriteStream['write'];
  process.stderr.write = ((chunk: unknown): boolean => {
    if (typeof chunk === 'string') stderrChunks.push(chunk);
    else if (chunk instanceof Uint8Array) stderrChunks.push(Buffer.from(chunk).toString('utf8'));
    return true;
  }) as NodeJS.WriteStream['write'];
  return {
    stdoutChunks,
    stderrChunks,
    restore: (): void => {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    },
  };
}

let recorder: StreamRecorder | null = null;

beforeEach(() => {
  resetRerankerForTesting();
  vi.resetModules();
});

afterEach(() => {
  recorder?.restore();
  recorder = null;
  resetRerankerForTesting();
  vi.resetModules();
});

describe('Reranker — stdout safety (RC1)', () => {
  it('reranker_load_does_not_reroute_concurrent_stdout_writes_to_stderr', async () => {
    recorder = installRecorder();
    const release = await loadWithStallingScorer();
    try {
      process.stdout.write(FRAME);

      const stdoutSawFrame = recorder.stdoutChunks.some((c) => c.includes('"jsonrpc"'));
      const stderrSawFrame = recorder.stderrChunks.some((c) => c.includes('"jsonrpc"'));
      expect(stdoutSawFrame, 'JSON-RPC frame must land on stdout, not stderr').toBe(true);
      expect(stderrSawFrame, 'JSON-RPC frame must NOT be rerouted to stderr').toBe(false);
    } finally {
      release();
    }
  });
});

/**
 * Drive Reranker's loadDefaultScorer with a stalled `@xenova/transformers`
 * mock. The wrap installs synchronously inside `loadDefaultScorer` before
 * the dynamic import resolves — our gate keeps it installed long enough to
 * observe the concurrent frame's routing.
 */
async function loadWithStallingScorer(): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });

  vi.doMock('@xenova/transformers', () => ({
    AutoTokenizer: {
      from_pretrained: async (): Promise<unknown> => {
        await gate;
        return ((): unknown => ({ input_ids: [], attention_mask: [] })) as unknown;
      },
    },
    AutoModelForSequenceClassification: {
      from_pretrained: async (): Promise<unknown> =>
        gate.then(
          () => async () => ({ logits: { data: new Float32Array(1), dims: [1, 1] } }),
        ),
    },
  }));

  const reranker = new Reranker({ downloadTimeoutMs: 10_000, circuitBreakerMs: 60_000 });
  void reranker.score('q', ['candidate']).catch(() => {
    /* released in test cleanup */
  });
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  return release;
}
