/**
 * Reranker adapter — wraps @xenova/transformers to score (query, candidate)
 * pairs via a cross-encoder model (default: Xenova/ms-marco-MiniLM-L-6-v2,
 * ~22 MB quantized on first use).
 *
 * Mirrors the embedder.ts lazy-load pattern. v2.6 added:
 *   - Bounded download race (RERANK_DOWNLOAD_TIMEOUT_MS, default 15s) →
 *     RerankerError('download_timeout') on overrun.
 *   - Single-flight load via in-flight loadPromise so concurrent first-
 *     callers don't duplicate the model download.
 *   - 60s circuit breaker after download_failed / download_timeout —
 *     subsequent score() calls within the window re-throw the cached error
 *     without re-attempting the load (prevents thundering herd on
 *     intermittent networks).
 *
 * stdio safety: the MCP stdio protocol reserves stdout for JSON-RPC frames.
 * `@xenova/transformers` v2 writes only to stderr through its progress
 * callback; we never replace `process.stdout.write`. (Older versions of
 * this module installed a stderr-redirect wrapper around the global write
 * during model load — that wrap straddled async `await` points and silently
 * rerouted concurrent MCP SDK frames to stderr, causing JSON-RPC `-32000`
 * timeouts on the client side. The defensive intent now lives in
 * `tests/unit/transformers_stdout_purity.test.ts` (CI regression gate) and
 * in `src/adapters/stdout_guard.ts:installStdoutTripwire` (opt-in runtime
 * side-observe wrapper).
 */

import { getLogger } from '../logging.js';
import {
  RERANK_MODEL,
  RERANK_DOWNLOAD_TIMEOUT_MS,
  RERANKER_CIRCUIT_BREAKER_MS,
} from '../config_rag.js';
import { RerankerError } from '../types.js';

export interface ScorerProgressEvent {
  status?: string;
  file?: string;
  progress?: number;
}

export interface ScorerImpl {
  /** Score (query, candidate) pairs — higher = more relevant. */
  score(query: string, candidates: string[]): Promise<number[]>;
  /** Optional: receive model-load progress events. Reranker forwards to stderr. */
  onProgressEvent?(event: ScorerProgressEvent): void;
}

export interface RerankerOpts {
  /** Hugging Face model id. Defaults to RERANK_MODEL from config. */
  modelName?: string;
  /** Test seam: inject a mock scorer instance (skips lazy load entirely). */
  scorerImpl?: ScorerImpl;
  /**
   * Test seam: inject a factory that returns a ScorerImpl asynchronously.
   * Lazy-load + single-flight + circuit-breaker logic engages around this
   * call. Use to mock download_timeout / download_failed paths.
   */
  scorerLoader?: () => Promise<ScorerImpl>;
  /** Override the default download-race timeout (used by tests). */
  downloadTimeoutMs?: number;
  /** Override the circuit-breaker skip-load window (used by tests). */
  circuitBreakerMs?: number;
}

/**
 * Reranker — instance class. Use `getReranker()` for the process-wide
 * singleton; tests can construct directly to avoid singleton state sharing.
 */
export class Reranker {
  private readonly modelName: string;
  private readonly downloadTimeoutMs: number;
  private readonly circuitBreakerMs: number;

  private readonly injectedScorer: ScorerImpl | null;
  private readonly injectedLoader: (() => Promise<ScorerImpl>) | null;
  private loadPromise: Promise<ScorerImpl> | null = null;

  /** v2.6 circuit breaker state — set on download_failed / download_timeout. */
  private lastFailureAt: number | null = null;
  private lastFailureError: RerankerError | null = null;

  constructor(opts: RerankerOpts = {}) {
    this.modelName = opts.modelName ?? RERANK_MODEL;
    this.downloadTimeoutMs = opts.downloadTimeoutMs ?? RERANK_DOWNLOAD_TIMEOUT_MS;
    this.circuitBreakerMs = opts.circuitBreakerMs ?? RERANKER_CIRCUIT_BREAKER_MS;
    this.injectedScorer = opts.scorerImpl ?? null;
    this.injectedLoader = opts.scorerLoader ?? null;
  }

  /**
   * v2.6: read the model fingerprint (audit-only). The reranker writes
   * nothing to `chunks` — `meta.rerank_model` is an audit-only row that
   * does NOT trigger chunk-drop on swap.
   */
  getFingerprint(): { model: string } {
    return { model: this.modelName };
  }

  /**
   * Score (query, candidate) pairs. Returns one score per candidate; higher
   * = more relevant. Empty `candidates` → empty array (no scorer load).
   */
  async score(query: string, candidates: string[]): Promise<number[]> {
    if (candidates.length === 0) return [];

    // Circuit breaker: within the skip-load window, re-throw the cached error.
    if (this.lastFailureAt !== null && this.lastFailureError !== null) {
      const sinceFailure = Date.now() - this.lastFailureAt;
      if (sinceFailure < this.circuitBreakerMs) {
        throw this.lastFailureError;
      }
      // Window expired — clear state and allow a retry below.
      this.lastFailureAt = null;
      this.lastFailureError = null;
    }

    let scorer: ScorerImpl;
    try {
      scorer = await this.resolveScorer();
    } catch (err) {
      if (err instanceof RerankerError && (err.kind === 'download_failed' || err.kind === 'download_timeout')) {
        // Trip the breaker.
        this.lastFailureAt = Date.now();
        this.lastFailureError = err;
      }
      throw err;
    }

    try {
      const scores = await scorer.score(query, candidates);
      if (scores.length !== candidates.length) {
        throw new RerankerError(
          'score_failed',
          `scorer returned ${scores.length} scores for ${candidates.length} candidates`,
        );
      }
      return scores;
    } catch (err) {
      if (err instanceof RerankerError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new RerankerError('score_failed', reason);
    }
  }

  /**
   * Close the underlying scorer AND clear the circuit-breaker state so a
   * subsequent `getReranker()` + `close()` cycle (e.g. across vitest cases)
   * starts clean.
   */
  async close(): Promise<void> {
    this.loadPromise = null;
    this.lastFailureAt = null;
    this.lastFailureError = null;
  }

  /** Lazy-resolve the underlying scorer (single-flight + bounded race). */
  private async resolveScorer(): Promise<ScorerImpl> {
    if (this.injectedScorer) return this.injectedScorer;
    // v0.7 test-mode seam: `CODEWIKI_TEST_STUB_RERANKER=1` bypasses the real
    // cross-encoder load; score() returns deterministically decreasing values.
    // Same rationale as the embedder seam — perf harness only.
    if (process.env.CODEWIKI_TEST_STUB_RERANKER === '1') {
      const stub: ScorerImpl = {
        async score(_query: string, candidates: string[]): Promise<number[]> {
          return candidates.map((_, i) => 1 - i * 0.01);
        },
      };
      this.loadPromise = Promise.resolve(stub);
      return this.loadPromise;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadScorerWithTimeout();
      // On failure, clear loadPromise so a later (post-breaker) call retries.
      this.loadPromise.catch(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  /** Wrap the actual load in a bounded race against `downloadTimeoutMs`. */
  private async loadScorerWithTimeout(): Promise<ScorerImpl> {
    const loadStart = Date.now();
    let timer: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race<ScorerImpl>([
        this.invokeLoader(),
        new Promise<ScorerImpl>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new RerankerError(
                'download_timeout',
                `reranker model load exceeded ${this.downloadTimeoutMs}ms (model=${this.modelName})`,
              ),
            );
          }, this.downloadTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      const loadDurMs = Date.now() - loadStart;
      getLogger().info('reranker.loaded', { model: this.modelName, loadDurMs });
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (err instanceof RerankerError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new RerankerError('download_failed', `${reason} (model=${this.modelName})`);
    }
  }

  /**
   * Invoke either the injected loader (test seam) OR the default
   * @xenova/transformers loader.
   */
  private invokeLoader(): Promise<ScorerImpl> {
    if (this.injectedLoader) return this.injectedLoader();
    return this.loadDefaultScorer();
  }

  /**
   * Load @xenova/transformers and build a cross-encoder scorer via
   * AutoTokenizer + AutoModelForSequenceClassification. The `text-classification`
   * pipeline does NOT forward `text_pair` to the tokenizer in v2.x
   * (pipelines.js:284 invokes `tokenizer(texts, {padding, truncation})` only),
   * so passing `[{ text, text_pair }, ...]` to it lands an array of objects
   * inside the tokenizer and triggers `text.split is not a function`. Driving
   * tokenizer + model directly is the documented transformers.js cross-encoder
   * pattern and keeps `text_pair` intact end-to-end.
   */
  private async loadDefaultScorer(): Promise<ScorerImpl> {
    const log = getLogger();
    log.info('reranker.load.start', { model: this.modelName });

    interface TransformersModule {
      AutoTokenizer: { from_pretrained: (name: string, opts?: unknown) => Promise<unknown> };
      AutoModelForSequenceClassification: { from_pretrained: (name: string, opts?: unknown) => Promise<unknown> };
    }
    let mod: TransformersModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = (await import('@xenova/transformers')) as any;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RerankerError(
        'download_failed',
        `Failed to load @xenova/transformers for reranker model ${this.modelName}: ${reason}`,
      );
    }

    const modelName = this.modelName;
    let lastProgress = 0;
    const progressCallback = (event: ScorerProgressEvent): void => {
      const now = Date.now();
      if (now - lastProgress < 1000) return;
      lastProgress = now;
      log.info('reranker.download', {
        model: modelName,
        file: event.file,
        progress: typeof event.progress === 'number' ? Math.round(event.progress) : undefined,
        status: event.status,
      });
    };

    let tokenizer: unknown;
    let model: unknown;
    try {
      tokenizer = await mod.AutoTokenizer.from_pretrained(modelName, {
        quantized: true,
        progress_callback: progressCallback,
      });
      model = await mod.AutoModelForSequenceClassification.from_pretrained(modelName, {
        quantized: true,
        progress_callback: progressCallback,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RerankerError(
        'download_failed',
        `Failed to download or initialize reranker model ${modelName}: ${reason}`,
      );
    }

    return {
      async score(query: string, candidates: string[]): Promise<number[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tok = tokenizer as (text: string | string[], opts?: any) => unknown;
        const mdl = model as (inputs: unknown) => Promise<{ logits: { data: ArrayLike<number>; dims: readonly number[] } }>;

        // Cross-encoder convention: tokenize the (query, passage) pair via
        // `text + text_pair`. Replicate query once per candidate so batch sizes
        // match — the tokenizer enforces equal lengths when both are arrays.
        const queries = candidates.map(() => query);
        let inputs: unknown;
        try {
          inputs = tok(queries, {
            text_pair: candidates,
            padding: true,
            truncation: true,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new RerankerError('score_failed', reason);
        }

        let outputs: { logits: { data: ArrayLike<number>; dims: readonly number[] } };
        try {
          outputs = await mdl(inputs);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new RerankerError('score_failed', reason);
        }

        // logits.data is a flat typed array of length batch * num_labels.
        // ms-marco-MiniLM-L-6-v2 is single-label regression (num_labels === 1)
        // so the raw logit IS the relevance score. For multi-label setups we
        // fall back to the last column (positive class convention).
        const data = outputs.logits.data;
        const dims = outputs.logits.dims;
        const batch = dims[0] ?? candidates.length;
        const numLabels = dims[1] ?? 1;
        if (data.length !== batch * numLabels) {
          throw new RerankerError(
            'score_failed',
            `unexpected logits shape: data.length=${data.length}, dims=[${dims.join(',')}]`,
          );
        }
        const col = numLabels === 1 ? 0 : numLabels - 1;
        const scores: number[] = new Array(batch);
        for (let i = 0; i < batch; i++) {
          scores[i] = Number(data[i * numLabels + col]);
        }
        return scores;
      },
    };
  }
}

let _instance: Reranker | null = null;

export async function getReranker(opts?: RerankerOpts): Promise<Reranker> {
  if (!_instance) {
    _instance = new Reranker(opts ?? {});
  }
  return _instance;
}

/** Test-only: clear the singleton so each test gets a fresh instance. */
export function resetRerankerForTesting(): void {
  _instance = null;
}
