/**
 * Regression test for the `text.split is not a function` bug observed against
 * @xenova/transformers v2.17.x — the `text-classification` pipeline does NOT
 * forward `text_pair` to the tokenizer (see node_modules/@xenova/transformers
 * /src/pipelines.js:284). Passing `[{ text, text_pair }, ...]` to the pipeline
 * therefore lands an array of objects in the tokenizer, which calls
 * `.split('～')` on each entry and explodes. The retriever then carries
 * `degraded: true` on every find_chunks call.
 *
 * The fix is to bypass the pipeline and drive the cross-encoder via
 * `AutoTokenizer` + `AutoModelForSequenceClassification` directly, mirroring
 * the documented transformers.js cross-encoder pattern. This test fails before
 * the fix (pipeline path explodes) and passes after (Auto* path returns
 * logit-derived scores).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type TokCall = { text: unknown; opts: { text_pair?: unknown; padding?: boolean; truncation?: boolean } };
const state: { tokCalls: TokCall[]; modelCalls: number } = { tokCalls: [], modelCalls: 0 };

vi.mock('@xenova/transformers', () => {
  // Fake tokenizer mimicking the v2.x AutoTokenizer shape: callable with
  // (text, opts) and returns a tensor-ish input bundle.
  let lastBatchSize = 0;
  const fakeTokenizer = (text: unknown, opts: TokCall['opts'] = {}): unknown => {
    state.tokCalls.push({ text, opts });
    // For the buggy pipeline path, callers pass an array of objects as `text`
    // — we faithfully mirror v2.17's failure mode so the test reproduces the
    // bug at exactly the layer it surfaces in production.
    const arr = Array.isArray(text) ? text : [text];
    for (const item of arr) {
      if (typeof item !== 'string') {
        const err = new TypeError('text.split is not a function');
        throw err;
      }
    }
    lastBatchSize = arr.length;
    return { input_ids: arr.map(() => [1, 2, 3]), attention_mask: arr.map(() => [1, 1, 1]) };
  };

  const fakeModel = async (_inputs: unknown): Promise<{ logits: { data: Float32Array; dims: number[] } }> => {
    state.modelCalls += 1;
    // Emit descending logits sized to the batch we just tokenized so callers
    // can verify per-candidate ordering regardless of how many they passed.
    const data = new Float32Array(lastBatchSize);
    for (let i = 0; i < lastBatchSize; i++) data[i] = lastBatchSize - i;
    return { logits: { data, dims: [lastBatchSize, 1] } };
  };

  // v2.17 pipeline that mimics the bug: ignores `text_pair`, hands the array
  // of objects to the tokenizer which throws as it would in production.
  const fakePipeline = async (_task: string, _model: string, _opts?: unknown): Promise<unknown> => {
    return async (inputs: unknown, _opts2?: unknown): Promise<Array<{ label: string; score: number }>> => {
      const arr = Array.isArray(inputs) ? inputs : [inputs];
      // TextClassificationPipeline._call invokes tokenizer(texts) WITHOUT
      // text_pair — replicate that here so the failure shape matches reality.
      fakeTokenizer(arr, { padding: true, truncation: true });
      return arr.map(() => ({ label: 'LABEL_0', score: 0 }));
    };
  };

  return {
    pipeline: fakePipeline,
    AutoTokenizer: {
      from_pretrained: async (_name: string): Promise<typeof fakeTokenizer> => fakeTokenizer,
    },
    AutoModelForSequenceClassification: {
      from_pretrained: async (_name: string): Promise<typeof fakeModel> => fakeModel,
    },
  };
});

beforeEach(() => {
  state.tokCalls.length = 0;
  state.modelCalls = 0;
});

describe('Reranker.loadDefaultScorer — v2.17 cross-encoder regression', () => {
  it('score() returns one numeric score per candidate against a v2.x transformers stub', async () => {
    const { Reranker } = await import('../../src/adapters/reranker.js');
    const r = new Reranker({});
    const scores = await r.score('what is foo', ['foo passage', 'bar passage', 'baz passage']);
    expect(scores).toHaveLength(3);
    for (const s of scores) {
      expect(typeof s).toBe('number');
      expect(Number.isFinite(s)).toBe(true);
    }
  });

  it('tokenizer is invoked with text + text_pair (not as array of objects)', async () => {
    const { Reranker } = await import('../../src/adapters/reranker.js');
    const r = new Reranker({});
    await r.score('q', ['p1', 'p2']);
    expect(state.tokCalls.length).toBeGreaterThan(0);
    const first = state.tokCalls[0];
    // The fix routes through AutoTokenizer with text_pair as a sibling option,
    // never as `[{text, text_pair}, ...]` objects to the tokenizer.
    expect(first.opts.text_pair).toBeDefined();
    // text input must be string or string[], never an array of objects.
    if (Array.isArray(first.text)) {
      for (const t of first.text) expect(typeof t).toBe('string');
    } else {
      expect(typeof first.text).toBe('string');
    }
  });

  it('model is invoked to obtain logits (not the text-classification pipeline)', async () => {
    const { Reranker } = await import('../../src/adapters/reranker.js');
    const r = new Reranker({});
    await r.score('q', ['p1', 'p2', 'p3']);
    expect(state.modelCalls).toBeGreaterThan(0);
  });

  it('candidate-rank order is preserved from logits (highest logit → highest score)', async () => {
    const { Reranker } = await import('../../src/adapters/reranker.js');
    const r = new Reranker({});
    const scores = await r.score('q', ['p1', 'p2', 'p3']);
    // Fake model emits descending logits [3, 2, 1] for batch=3.
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
  });
});
