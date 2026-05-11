/**
 * v2 RAG configuration knobs (find_chunks, indexer, retriever, vector store).
 * Lives in a sibling file to src/config.ts for two reasons:
 *  1. Keeps the embedder/indexer's import surface narrow — only RAG callers
 *     import from here.
 *  2. Avoids touching the v1 config file when adding v2 knobs.
 *
 * All knobs are env-overridable; defaults match the plan (Runtime Environment).
 */

function envString(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

export const EMBED_MODEL = envString('CODEWIKI_EMBED_MODEL', 'Xenova/bge-small-en-v1.5');
export const EMBED_MODEL_DIM = envNumber('CODEWIKI_EMBED_MODEL_DIM', 384);
export const CHUNK_MAX_TOKENS = envNumber('CODEWIKI_CHUNK_MAX_TOKENS', 512);
export const CHUNK_OVERLAP_TOKENS = envNumber('CODEWIKI_CHUNK_OVERLAP_TOKENS', 64);
export const INDEX_TTL_MS = envNumber('CODEWIKI_INDEX_TTL_MS', 24 * 60 * 60 * 1000);
export const INDEX_BUILD_TIMEOUT_MS = envNumber('CODEWIKI_INDEX_BUILD_TIMEOUT_MS', 5000);
export const FORCE_PUREJS_VECTOR = envBool('CODEWIKI_FORCE_PUREJS_VECTOR');


/**
 * v2.5: the v2/v2.1/v2.2/v2.3/v2.4 default embed model + dim. Used by the
 * startup hook to synthesize a fingerprint when a populated index is found
 * with no persisted fingerprint row (legacy v2.4 DB). Do NOT change without
 * bumping the auto-reindex contract — changing this value would mis-classify
 * legacy DBs and silently NOT trigger a needed re-index.
 */
export const LEGACY_EMBED_MODEL_DEFAULT = Object.freeze({
  model: 'Xenova/bge-small-en-v1.5',
  dim: 384,
});

// ---------------------------------------------------------------------------
// v2.6 cross-encoder reranker knobs
// ---------------------------------------------------------------------------

/** Hugging Face cross-encoder model id (quantized, ~22 MB on first load). */
export const RERANK_MODEL = envString('CODEWIKI_RERANK_MODEL', 'Xenova/ms-marco-MiniLM-L-6-v2');

/** Vector top-N candidates fed to the reranker per find_chunks call. */
export const RERANK_TOP_N = envNumber('CODEWIKI_RERANK_TOP_N', 50);

/** Bounded race for the cross-encoder model load. Default 15s. */
export const RERANK_DOWNLOAD_TIMEOUT_MS = envNumber('CODEWIKI_RERANK_DOWNLOAD_TIMEOUT_MS', 15000);

/** Skip-load window after a download_failed / download_timeout. Default 60s. */
export const RERANKER_CIRCUIT_BREAKER_MS = envNumber('CODEWIKI_RERANKER_CIRCUIT_BREAKER_MS', 60000);

// ---------------------------------------------------------------------------
// v2.7 hybrid retrieval (BM25 + vector via Reciprocal Rank Fusion)
// ---------------------------------------------------------------------------

/**
 * v2.7 operator escape: when CODEWIKI_FORCE_NO_BM25=1, the retriever skips
 * the BM25 branch and engages vector-only mode. Mirrors the v2.6
 * CODEWIKI_FORCE_PUREJS_VECTOR pattern. Read once at VectorStore
 * construction. The eval harness uses this for the vectorOnly baseline.
 */
export const FORCE_NO_BM25 = envBool('CODEWIKI_FORCE_NO_BM25');

/**
 * v2.7 Reciprocal Rank Fusion constant. Default 60 (Cormack et al. 2009,
 * the industry standard for hybrid retrieval). Larger k flattens the
 * fusion curve; smaller k sharpens it. Env-overridable per-corpus.
 */
export const RRF_K = envNumber('CODEWIKI_RRF_K', 60);
