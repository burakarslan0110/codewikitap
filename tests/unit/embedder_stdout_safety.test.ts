/**
 * RED test for the MCP `-32000` reconnect bug — RC1 / embedder leg.
 *
 * The embedder lazy-loads `@xenova/transformers` on first encode(). Today
 * (src/adapters/embedder.ts:91-101) the loader globally replaces
 * `process.stdout.write` with a stderr-redirect for the ENTIRE duration of
 * the async model load. Because the wrap straddles `await` points, any
 * CONCURRENT call to `process.stdout.write(...)` — including the MCP SDK's
 * `StdioServerTransport.send(...)` which is literally `process.stdout.write(json)`
 * (node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js:66) — is
 * silently rerouted to stderr. JSON-RPC clients then time out → -32000.
 *
 * This test pins down the bug by recording every write to stdout AND stderr
 * (capture-and-forward recorders), kicking off the embedder load via the
 * default loader with a stalled `@xenova/transformers` mock, and writing a
 * representative JSON-RPC frame to `process.stdout` from the same coroutine.
 *
 * Status BEFORE the fix: FAILS — recorders show frame on stderr, not stdout.
 * Status AFTER the fix: PASSES — wrap is deleted, frame lands on stdout.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

import { Embedder, resetEmbedderForTesting } from '../../src/adapters/embedder.js';

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
  resetEmbedderForTesting();
  vi.resetModules();
});

afterEach(() => {
  recorder?.restore();
  recorder = null;
  resetEmbedderForTesting();
  vi.resetModules();
});

describe('Embedder — stdout safety (RC1)', () => {
  it('embedder_load_does_not_reroute_concurrent_stdout_writes_to_stderr', async () => {
    // Install the recorder FIRST so it becomes the `originalWrite` captured
    // by `loadDefaultEncoder`'s wrap. Then kick the embedder load — the wrap
    // layers ON TOP of our recorder. A subsequent `process.stdout.write(FRAME)`
    // call goes through the wrap, which redirects to `process.stderr.write`
    // — our stderr recorder intercepts that.
    //
    // BUG manifests: stdout recorder NEVER sees the frame (wrap diverts);
    // stderr recorder DOES see it.
    // FIX restores: stdout recorder sees the frame; stderr recorder does not.
    recorder = installRecorder();
    const release = await loadWithStallingTransformers();
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
 * Drive the real `Embedder.loadDefaultEncoder` path with a stalled
 * `@xenova/transformers` mock so the stdout wrap stays installed for the
 * duration of the test.
 */
async function loadWithStallingTransformers(): Promise<() => void> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });

  vi.doMock('@xenova/transformers', () => ({
    pipeline: async (): Promise<unknown> => {
      await gate;
      return async (): Promise<{ data: Float32Array; dims: number[] }> => ({
        data: new Float32Array(8),
        dims: [1, 8],
      });
    },
  }));

  const embedder = new Embedder({ modelDim: 8 });
  // Kick the load without awaiting — the wrap installs synchronously,
  // then the loader awaits our gated import.
  void embedder.encode(['warmup']).catch(() => {
    /* expected: test cleanup will release */
  });
  // Yield enough microtasks for the wrap to be installed AND the dynamic
  // import to have started awaiting on the gate.
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
  return release;
}
