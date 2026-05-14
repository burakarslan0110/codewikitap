/**
 * v2.7: Reciprocal Rank Fusion (RRF) for hybrid retrieval.
 *
 * Combines a dense-vector ranked list with a sparse-BM25 ranked list into
 * a single deduped+ranked candidate set. RRF is score-scale agnostic — it
 * uses RANKS, not raw scores — so the same formula works for unbounded
 * BM25 and bounded cosine. Industry standard for hybrid retrieval
 * (Elasticsearch's `rrf`, Vespa's `reciprocal_rank_fusion`, Weaviate's
 * hybrid search, etc.).
 *
 * Formula: `RRF(d) = Σ_L 1/(k + rank_L(d))` summed over each ranking list
 * `L` the candidate appears in. Default `k = 60` (Cormack et al. 2009).
 *
 * Also exports `escapeBM25Query(query)` — sanitizes user input for FTS5's
 * MATCH grammar. Strips characters with special meaning (`*`, `:`, `(`,
 * `)`, `"`, etc.) and returns a whitespace-separated token list safe to
 * pass into `WHERE fts_chunks MATCH ?`.
 */

import type { QueryResult, BM25QueryResult } from './vector_store.js';
import type { IndexedChunk } from '../types.js';

export interface FusedResult {
  /** The underlying chunk (single instance even when present in both lists). */
  chunk: IndexedChunk;
  /** RRF score (higher = better). Sum of 1/(k+rank) across both lists. */
  rrfScore: number;
  /** 1-indexed rank in the vector list, or null if not in vector top-N. */
  vectorRank: number | null;
  /** 1-indexed rank in the BM25 list, or null if not in BM25 top-N. */
  bm25Rank: number | null;
  /** Cosine similarity score from the vector list, or null. */
  vectorScore: number | null;
  /** Inverted BM25 score (higher = better), or null. */
  bm25Score: number | null;
}

export interface FusionOptions {
  /** RRF constant. Default 60. Larger k flattens the curve; smaller k sharpens it. */
  k?: number;
  /** Maximum returned candidates. Default Infinity (no cap). */
  cap?: number;
}

/**
 * Reciprocal Rank Fusion over two ranked lists.
 *
 * Input lists are assumed to be sorted best-first. Duplicate chunks
 * (same composite PK: `repo|pageSlug|sectionSlug|ordinal`) are deduped;
 * their RRF scores sum across the lists. Vector-only and BM25-only
 * candidates appear with their single-list contribution.
 *
 * Returns a fresh array sorted by `rrfScore` desc, capped at `cap`.
 * Pure function — no I/O, no logging, deterministic on the inputs.
 */
export function reciprocalRankFusion(
  vector: QueryResult[],
  bm25: BM25QueryResult[],
  opts: FusionOptions = {},
): FusedResult[] {
  const k = opts.k ?? 60;
  const cap = opts.cap ?? Infinity;

  const merged = new Map<string, FusedResult>();

  for (let i = 0; i < vector.length; i++) {
    const v = vector[i];
    const key = chunkKey(v);
    const rank = i + 1;
    const contribution = 1 / (k + rank);
    merged.set(key, {
      chunk: v,
      rrfScore: contribution,
      vectorRank: rank,
      bm25Rank: null,
      vectorScore: v.score,
      bm25Score: null,
    });
  }

  for (let i = 0; i < bm25.length; i++) {
    const b = bm25[i];
    const key = chunkKey(b);
    const rank = i + 1;
    const contribution = 1 / (k + rank);
    const existing = merged.get(key);
    if (existing) {
      existing.rrfScore += contribution;
      existing.bm25Rank = rank;
      existing.bm25Score = b.score;
    } else {
      merged.set(key, {
        chunk: b,
        rrfScore: contribution,
        vectorRank: null,
        bm25Rank: rank,
        vectorScore: null,
        bm25Score: b.score,
      });
    }
  }

  const out = Array.from(merged.values());
  out.sort((a, b) => b.rrfScore - a.rrfScore);
  if (Number.isFinite(cap) && out.length > cap) {
    out.length = cap as number;
  }
  return out;
}

function chunkKey(c: IndexedChunk): string {
  return `${c.repo}|${c.pageSlug}|${c.sectionSlug}|${c.ordinal}`;
}

/**
 * Sanitize a user query for FTS5's MATCH grammar. Tokenize on whitespace,
 * strip all non-Unicode-letter/digit characters per token, drop empties,
 * rejoin as quoted OR-clauses. Returns empty string when no tokens survive
 * — the caller must short-circuit to vector-only mode in that case (FTS5
 * `WHERE ... MATCH ''` throws SQLITE_ERROR).
 *
 * OR-join rationale: FTS5's default operator between bare tokens is AND,
 * so the prior space-join required every token to co-occur in a single
 * chunk — natural-language queries returned zero BM25 rows, silently
 * degrading hybrid retrieval to vector-only despite reporting
 * `mode: "hybrid"`. OR-join keeps the BM25 lane wide; BM25 ranking still
 * favors chunks that match more tokens, so RRF receives a useful sparse
 * list. Each token is wrapped in double quotes so tokens that happen to
 * equal FTS5 keywords (AND, OR, NOT, NEAR) after stripping are treated
 * as phrases, not operators.
 *
 * Examples:
 *   "auth setup"              → "\"auth\" OR \"setup\""
 *   "*foo*"                   → "\"foo\""
 *   "fts5(text)"              → "\"fts5text\""
 *   "!@#$%"                   → ""
 *   "useState"                → "\"useState\"" (CamelCase kept as single token)
 *   "snake_case_function"     → "\"snakecasefunction\"" (underscores stripped in v2.7)
 */
export function escapeBM25Query(query: string): string {
  if (!query) return '';
  // Split on whitespace, strip non-alphanumeric (Unicode-aware).
  const tokens = query
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
