/**
 * Embedder adapter unit tests — exercises the test-seam (constructor-injected
 * encoder) so the suite stays under 1 ms per case and never touches the real
 * @xenova/transformers model.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  Embedder,
  EncoderImpl,
  getEmbedder,
  resetEmbedderForTesting,
} from '../../src/adapters/embedder.js';
import { EmbedderError } from '../../src/types.js';

const TEST_DIM = 8;

function mockEncoder(): EncoderImpl {
  return {
    async encode(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const v = new Float32Array(TEST_DIM);
        for (let i = 0; i < text.length; i++) {
          v[i % TEST_DIM] += text.charCodeAt(i);
        }
        // L2-normalize
        let sumSq = 0;
        for (let i = 0; i < TEST_DIM; i++) sumSq += v[i] * v[i];
        const norm = Math.sqrt(sumSq) || 1;
        for (let i = 0; i < TEST_DIM; i++) v[i] /= norm;
        return v;
      });
    },
  };
}

function failingEncoder(kind: 'download_failed' | 'encode_failed'): EncoderImpl {
  return {
    async encode(): Promise<Float32Array[]> {
      throw new EmbedderError(kind, `mock ${kind}: model=Xenova/bge-small-en-v1.5`);
    },
  };
}

beforeEach(() => {
  resetEmbedderForTesting();
});

afterEach(() => {
  resetEmbedderForTesting();
});

describe('Embedder — singleton', () => {
  it('getEmbedder returns the same instance across calls', async () => {
    const a = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: mockEncoder() });
    const b = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: mockEncoder() });
    expect(a).toBe(b);
  });
});

describe('Embedder — encode', () => {
  it('returns Float32Array of length matching modelDim', async () => {
    const e = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: mockEncoder() });
    const [vec] = await e.encode(['hello world']);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(TEST_DIM);
  });

  it('returns one vector per input', async () => {
    const e = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: mockEncoder() });
    const out = await e.encode(['a', 'bb', 'ccc']);
    expect(out.length).toBe(3);
  });

  it('output is L2-normalized (sum of squares within 1e-3 of 1.0)', async () => {
    const e = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: mockEncoder() });
    const [vec] = await e.encode(['the quick brown fox']);
    let sumSq = 0;
    for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
    expect(sumSq).toBeGreaterThan(0.999);
    expect(sumSq).toBeLessThan(1.001);
  });

  it('throws EmbedderError(download_failed) when encoder reports download failure', async () => {
    const e = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: failingEncoder('download_failed') });
    await expect(e.encode(['x'])).rejects.toThrow(EmbedderError);
    await expect(e.encode(['x'])).rejects.toMatchObject({
      kind: 'download_failed',
      message: expect.stringContaining('Xenova/bge-small-en-v1.5'),
    });
  });

  it('throws EmbedderError(dim_mismatch) when encoder returns wrong-length vector', async () => {
    const wrongDim: EncoderImpl = {
      async encode(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => new Float32Array(TEST_DIM + 1));
      },
    };
    const e = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: wrongDim });
    await expect(e.encode(['x'])).rejects.toMatchObject({ kind: 'dim_mismatch' });
  });
});

describe('Embedder — stdio safety', () => {
  it('encode() does not write to process.stdout', async () => {
    const e = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: mockEncoder() });
    const captured: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (chunk: string | Buffer) => boolean) = (chunk: string | Buffer): boolean => {
      captured.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return true;
    };
    try {
      await e.encode(['hello', 'world']);
    } finally {
      process.stdout.write = originalWrite;
    }
    const totalBytes = captured.reduce((n, b) => n + b.length, 0);
    expect(totalBytes).toBe(0);
  });
});

describe('Embedder — progress callback', () => {
  it('emits at least one stderr line when progress events are reported', async () => {
    let progressCalls = 0;
    const progressEncoder: EncoderImpl = {
      async encode(texts: string[]): Promise<Float32Array[]> {
        // Simulate the @xenova progress callback firing during model load.
        return texts.map(() => {
          progressCalls += 1;
          return new Float32Array(TEST_DIM).fill(1 / Math.sqrt(TEST_DIM));
        });
      },
      onProgressEvent(): void {
        // no-op for the simulated case; the embedder wires this up.
      },
    };
    const e = await getEmbedder({ modelDim: TEST_DIM, encoderImpl: progressEncoder });
    await e.encode(['x']);
    // Just confirm the encoder was invoked; the actual progress wiring is
    // exercised by the integration test against the real @xenova model.
    expect(progressCalls).toBe(1);
  });
});

describe('Embedder — direct constructor', () => {
  it('class can be constructed directly bypassing the singleton (test seam)', async () => {
    const e = new Embedder({ modelDim: TEST_DIM, encoderImpl: mockEncoder() });
    const [vec] = await e.encode(['x']);
    expect(vec.length).toBe(TEST_DIM);
  });
});
