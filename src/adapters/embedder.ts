/**
 * Embedder adapter — wraps @xenova/transformers to produce L2-normalized
 * sentence embeddings via Xenova/bge-small-en-v1.5 (or env-overridable).
 *
 * The default implementation lazy-loads @xenova/transformers on first use so
 * the v1 server still starts without the embedding model present (only Task 5
 * onward triggers the load). Tests substitute a mock encoder via the
 * constructor's `encoderImpl` option to avoid the ~30 MB model download in CI.
 *
 * stdio safety: the MCP stdio protocol reserves stdout for JSON-RPC frames.
 * `@xenova/transformers` v2 writes only to stderr through its progress
 * callback; we never replace `process.stdout.write`. (Older versions of this
 * module installed a stderr-redirect wrapper around the global write during
 * model load — that wrap straddled async `await` points and silently
 * rerouted concurrent MCP SDK frames to stderr, causing JSON-RPC `-32000`
 * timeouts on the client side. The defensive intent now lives in
 * `tests/unit/transformers_stdout_purity.test.ts` (CI regression gate) and
 * in `src/adapters/stdout_guard.ts:installStdoutTripwire` (opt-in runtime
 * side-observe wrapper).
 */

import { getLogger } from '../logging.js';
import { EMBED_MODEL, EMBED_MODEL_DIM } from '../config_rag.js';
import { EmbedderError } from '../types.js';

export interface EncoderProgressEvent {
  status?: string;
  file?: string;
  progress?: number;
}

export interface EncoderImpl {
  /** Encode a batch of strings into L2-normalized vectors of length modelDim. */
  encode(texts: string[]): Promise<Float32Array[]>;
  /** Optional: receive model-load progress events. Embedder forwards to stderr. */
  onProgressEvent?(event: EncoderProgressEvent): void;
}

export interface EmbedderOpts {
  /** Hugging Face model repo ID. Defaults to EMBED_MODEL from config. */
  modelName?: string;
  /** Embedding dimension; must match the model's output. Defaults to EMBED_MODEL_DIM. */
  modelDim?: number;
  /** Test seam: inject a mock encoder so the suite never touches the real model. */
  encoderImpl?: EncoderImpl;
}

/**
 * Embedder — instance class. Use `getEmbedder()` for the process-wide singleton;
 * tests can construct directly to avoid singleton sharing.
 */
export class Embedder {
  private readonly modelName: string;
  private readonly modelDim: number;
  private encoderPromise: Promise<EncoderImpl> | null = null;
  private readonly injectedEncoder: EncoderImpl | null;

  constructor(opts: EmbedderOpts = {}) {
    this.modelName = opts.modelName ?? EMBED_MODEL;
    this.modelDim = opts.modelDim ?? EMBED_MODEL_DIM;
    this.injectedEncoder = opts.encoderImpl ?? null;
  }

  /**
   * v2.5: read the constructor-resolved fingerprint (model + dim). Used by
   * the indexer to stamp `meta.embed_model` + `meta.embed_model_dim` after
   * each successful build, and by tests to assert fingerprint propagation.
   */
  getFingerprint(): { model: string; dim: number } {
    return { model: this.modelName, dim: this.modelDim };
  }

  /** Lazy-resolve the underlying encoder. */
  private async resolveEncoder(): Promise<EncoderImpl> {
    if (this.injectedEncoder) return this.injectedEncoder;
    if (!this.encoderPromise) {
      this.encoderPromise = this.loadDefaultEncoder();
    }
    return this.encoderPromise;
  }

  /**
   * Load @xenova/transformers and build a feature-extraction pipeline.
   * Wrapped so a missing/broken native binding throws EmbedderError, not a
   * generic module-load error.
   */
  private async loadDefaultEncoder(): Promise<EncoderImpl> {
    const log = getLogger();
    log.info('embedder.load.start', { model: this.modelName });

    let mod: { pipeline: (task: string, model: string, opts?: unknown) => Promise<unknown> };
    try {
      // Dynamic import keeps @xenova/transformers off the v1 hot path. If the
      // package is missing or fails to compile native deps, surface as
      // download_failed so callers see actionable error UX.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = (await import('@xenova/transformers')) as any;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new EmbedderError(
        'download_failed',
        `Failed to load @xenova/transformers for model ${this.modelName}: ${reason}`,
      );
    }

    const modelName = this.modelName;
    let lastProgress = 0;
    const progressCallback = (event: EncoderProgressEvent): void => {
      const now = Date.now();
      if (now - lastProgress < 1000) return;
      lastProgress = now;
      log.info('embedder.download', {
        model: modelName,
        file: event.file,
        progress: typeof event.progress === 'number' ? Math.round(event.progress) : undefined,
        status: event.status,
      });
    };

    let pipe: unknown;
    try {
      pipe = await mod.pipeline('feature-extraction', modelName, {
        quantized: true,
        progress_callback: progressCallback,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new EmbedderError(
        'download_failed',
        `Failed to download or initialize embedding model ${modelName}: ${reason}`,
      );
    }

    return {
      async encode(texts: string[]): Promise<Float32Array[]> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fn = pipe as (texts: string[], opts?: unknown) => Promise<any>;
        let result: { data: Float32Array; dims: number[] };
        try {
          result = await fn(texts, { pooling: 'mean', normalize: true });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new EmbedderError('encode_failed', `encode failed: ${reason}`);
        }
        // Slice the flat tensor into per-text rows.
        const dim = result.dims[result.dims.length - 1];
        const out: Float32Array[] = [];
        for (let i = 0; i < texts.length; i++) {
          out.push(new Float32Array(result.data.buffer, result.data.byteOffset + i * dim * 4, dim));
        }
        return out;
      },
    };
  }

  /** Encode a batch of texts. Throws EmbedderError on failure. */
  async encode(texts: string[]): Promise<Float32Array[]> {
    const encoder = await this.resolveEncoder();
    let vectors: Float32Array[];
    try {
      vectors = await encoder.encode(texts);
    } catch (err) {
      if (err instanceof EmbedderError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new EmbedderError('encode_failed', reason);
    }
    if (vectors.length !== texts.length) {
      throw new EmbedderError(
        'encode_failed',
        `encoder returned ${vectors.length} vectors for ${texts.length} inputs`,
      );
    }
    for (let i = 0; i < vectors.length; i++) {
      if (vectors[i].length !== this.modelDim) {
        throw new EmbedderError(
          'dim_mismatch',
          `expected ${this.modelDim}-dim vector, got ${vectors[i].length} for input #${i}`,
        );
      }
    }
    return vectors;
  }

  /** Close the underlying encoder. */
  async close(): Promise<void> {
    this.encoderPromise = null;
  }
}

let _instance: Embedder | null = null;

export async function getEmbedder(opts?: EmbedderOpts): Promise<Embedder> {
  if (!_instance) {
    _instance = new Embedder(opts ?? {});
  }
  return _instance;
}

/** Test-only: clear the singleton so each test gets a fresh instance. */
export function resetEmbedderForTesting(): void {
  _instance = null;
}
