/**
 * Retriever — encodes a query, races the indexer against INDEX_BUILD_TIMEOUT_MS,
 * runs vector search, and builds per-chunk citations with byte-equal footers.
 *
 * Race contract: `findChunks(query, repo, k)` calls `indexer.indexRepo(repo)`
 * to obtain its in-flight promise (single-flight returns the existing promise
 * if a build is running). That promise is raced against a setTimeout. On
 * timeout, returns `{ chunks: [], status: 'index_building' }` immediately;
 * the build continues in the background, so a follow-up call seconds later
 * either gets the in-flight promise (if still running) or hits the populated
 * index (if completed).
 *
 * Citation contract: chunk text is rendered through `serialize()` from
 * `src/extraction/serializer.ts` so the footer is byte-equal to the v1 contract.
 * Any pre-existing footer in the stored chunk text is stripped first using
 * CITATION_FOOTER_REGEX to prevent doubling.
 */

import { Embedder } from '../adapters/embedder.js';
import { Reranker } from '../adapters/reranker.js';
import type { Cache } from './cache.js';
import { VectorStore, QueryResult, BM25QueryResult } from './vector_store.js';
import type { Indexer, IndexerResult } from './indexer.js';
import { CITATION_FOOTER_REGEX, serialize } from '../extraction/serializer.js';
import { CODEWIKI_BASE_URL } from '../config.js';
import { INDEX_BUILD_TIMEOUT_MS, INDEX_TTL_MS, RERANK_TOP_N, RRF_K } from '../config_rag.js';
import { getLogger } from '../logging.js';
import type { Citation, Fallback } from '../types.js';
import { EmbedderError, RerankerError } from '../types.js';
import { reciprocalRankFusion, escapeBM25Query, FusedResult } from './fusion.js';

export interface RetrieverDeps {
  embedder: Embedder;
  store: VectorStore;
  indexer: Pick<Indexer, 'indexRepo'>;
  /**
   * v2.6: cross-encoder reranker. Always invoked on findChunks (top-N vector
   * candidates → reranker → top-K slice). On RerankerError, degraded path
   * returns vector-only ordering with `degraded: true`.
   */
  reranker: Reranker;
  /**
   * v2.6 optional: when provided, the Retriever stamps `meta.rerank_model`
   * once per process after the first successful rerank (audit-only — does
   * NOT trigger chunk drop). Tests can omit this dep.
   */
  cache?: Pick<Cache, 'getRerankModel' | 'setRerankModel'>;
  /**
   * v2.7 test seam: when true, the retriever skips the VECTOR branch and
   * runs BM25-only. Used by the eval harness's `bm25Only` baseline.
   * Constructor-level only (not env-driven); operators have
   * `CODEWIKI_FORCE_NO_BM25` for the inverse path. Underscore-prefixed
   * to mark non-public.
   */
  __testOnly_forceBM25Only?: boolean;
}

export interface RetrievedChunk {
  repo: string;
  pageSlug: string;
  sectionSlug: string;
  ordinal: number;
  /**
   * Effective score = rerankScore when rerank succeeded; vectorScore on
   * degraded fallback path. Preserved for v2.5-compatible callers.
   */
  score: number;
  /** v2.6: cosine similarity from the vector layer (may be null on v2.7 BM25-only hits). */
  vectorScore: number | null;
  /** v2.6: cross-encoder rerank score; null when degraded fallback engaged. */
  rerankScore: number | null;
  /** v2.7: inverted BM25 score from FTS5, or null when chunk only came from vector. */
  bm25Score?: number | null;
  /** v2.7: 1-indexed rank in the BM25 list, or null. */
  bm25Rank?: number | null;
  /** v2.7: 1-indexed rank in the vector list, or null. */
  vectorRank?: number | null;
  /** v2.7: Reciprocal Rank Fusion score (always present on hybrid path). */
  rrfScore?: number | null;
  text: string;
  citation: Citation;
}

export interface FindChunksOptions {
  /** Override the default INDEX_BUILD_TIMEOUT_MS (used by tests). */
  timeoutMs?: number;
  /** v2.5: pagination offset (default 0). */
  offset?: number;
  /** v2.6 test seam: override the rerank top-N candidate window. */
  rerankTopN?: number;
}

export interface FindChunksResult {
  chunks: RetrievedChunk[];
  truncated: boolean;
  total: number;
  repoTotal?: number;
  degraded?: boolean;
  /** v2.7: which retrieval path produced this response. */
  hybrid?: 'hybrid' | 'vector_only' | 'partial';
  /** v2.7: per-call audit field for debugging hybrid behavior. */
  hybridStats?: {
    rrfK: number;
    vectorCount: number;
    bm25Count: number;
    fusedCount: number;
    /**
     * F2: per-repo retrieval-path label (engaged-path semantic, locked by
     * TS-005) PLUS the actual BM25 row count for that repo on this call.
     * `mode` answers "did BM25 fire?"; `bm25Count` answers "did BM25
     * contribute rows?". Together they disambiguate engaged-but-empty
     * BM25 from skipped BM25 without breaking the documented mode semantic.
     */
    perRepo: Record<string, { mode: 'hybrid' | 'vector_only'; bm25Count: number }>;
  };
  status?: 'no_docs' | 'rate_limited' | 'retry' | 'index_building';
  retryAfterSeconds?: number;
  fallbacks?: Fallback[];
  reason?: string;
}

/** Fan-out cap for the cross-repo branch. */
const CROSS_REPO_CAP = 16;

export class Retriever {
  constructor(private readonly deps: RetrieverDeps) {}

  async findChunks(
    query: string,
    repo: string | undefined,
    k = 8,
    opts: FindChunksOptions = {},
  ): Promise<FindChunksResult> {
    const timeoutMs = opts.timeoutMs ?? INDEX_BUILD_TIMEOUT_MS;
    const offset = Math.max(0, opts.offset ?? 0);
    const rerankTopN = Math.max(1, opts.rerankTopN ?? RERANK_TOP_N);
    const log = getLogger();

    const targetRepos = await this.resolveTargetRepos(repo, timeoutMs);
    if (!('repos' in targetRepos)) {
      return targetRepos;
    }
    if (targetRepos.repos.length === 0) {
      return { chunks: [], truncated: false, total: 0 };
    }

    // Catch EmbedderError on query encoding → map to structured retry status
    // (the plan's failure-UX contract: model download/encode failures must NOT
    // escape as raw exceptions; clients see status='retry' instead).
    let queryVec: Float32Array;
    try {
      [queryVec] = await this.deps.embedder.encode([query]);
    } catch (err) {
      if (err instanceof EmbedderError) {
        return {
          chunks: [],
          truncated: false,
          total: 0,
          status: 'retry',
          retryAfterSeconds: 60,
          reason: `embedder ${err.kind}: ${err.message}`,
        };
      }
      throw err;
    }

    // v2.7: hybrid retrieval — vector top-N AND BM25 top-N per repo, fused
    // via RRF, capped at RERANK_TOP_N for the reranker pass. Degraded paths:
    //   - bm25Only test seam → skip vector entirely
    //   - !store.hasBm25() (operator escape or FTS5 unavailable) → vector_only
    //   - empty post-escape query → vector_only with reason
    const bm25OnlyTest = this.deps.__testOnly_forceBM25Only === true;
    const escapedQuery = escapeBM25Query(query);
    const bm25Enabled = bm25OnlyTest || (this.deps.store.hasBm25() && escapedQuery.length > 0);
    let forcedVectorOnlyReason: string | null = null;
    if (this.deps.store.hasBm25() && escapedQuery.length === 0) {
      forcedVectorOnlyReason = 'empty_query_tokens';
      log.warn('retriever.hybrid_empty_query_tokens', { query });
    } else if (!this.deps.store.hasBm25()) {
      forcedVectorOnlyReason = 'force_no_bm25';
    }

    const fusedAll: FusedResult[] = [];
    const perRepoMode: Record<string, { mode: 'hybrid' | 'vector_only'; bm25Count: number }> = {};
    let totalVectorCount = 0;
    let totalBm25Count = 0;
    let repoTotal = 0;
    let truncated = false;

    const fusionT0 = Date.now();
    // PSF-003 helper: composite key matches the fusion module's dedup key
    // (`repo|pageSlug|sectionSlug|ordinal`). Re-defined locally to avoid
    // exporting an internal from fusion.ts.
    const compositeKey = (c: QueryResult | BM25QueryResult): string =>
      `${c.repo}|${c.pageSlug}|${c.sectionSlug}|${c.ordinal}`;

    for (const r of targetRepos.repos) {
      let vectorRows: QueryResult[] = [];
      let vectorTotal = 0;
      if (!bm25OnlyTest) {
        const vectorPaged = this.deps.store.queryChunksPaged(r, queryVec, 0, rerankTopN);
        vectorRows = vectorPaged.rows;
        vectorTotal = vectorPaged.total;
        repoTotal += vectorTotal;
        if (vectorTotal > rerankTopN) truncated = true;
      }
      let bm25Rows: BM25QueryResult[] = [];
      let bm25Total = 0;
      if (bm25Enabled) {
        try {
          const bm25Paged = this.deps.store.queryChunksBM25(r, escapedQuery, 0, rerankTopN);
          bm25Rows = bm25Paged.rows;
          bm25Total = bm25Paged.total;
        } catch (err) {
          log.warn('retriever.bm25_query_failed', {
            repo: r,
            reason: err instanceof Error ? err.message : String(err),
          });
          bm25Rows = [];
          bm25Total = 0;
        }
      }
      // PSF-003: extend `repoTotal` to include BM25-only chunks across the
      // FULL BM25 candidate set (not just the returned slice). Codex found
      // the prior implementation under-counted BM25-only matches beyond
      // the rerank window. We now use `bm25Paged.total` (the COUNT(*) over
      // all FTS5 matches for this repo) and subtract the overlap OBSERVED
      // in the returned top-N — a best-effort lower bound on the true
      // BM25-only contribution. Worst case (returned slice has no overlap):
      // we credit `bm25Total` fully; if the unreturned portion has higher
      // overlap rate than the returned slice, we slightly over-count, which
      // is the right error direction (pagination clients walk one extra
      // empty page rather than under-walking and missing chunks).
      if (bm25Enabled) {
        // Codex finding: use `bm25Total` (COUNT(*) over all FTS5 matches
        // for this repo), NOT bm25Rows.length (capped at rerankTopN). The
        // prior implementation under-counted BM25-only matches beyond the
        // rerank window. We subtract the overlap observed in the returned
        // top-N as a best-effort proxy for the actual full overlap.
        const vectorKeys = new Set(vectorRows.map(compositeKey));
        let overlapInReturned = 0;
        for (const b of bm25Rows) {
          if (vectorKeys.has(compositeKey(b))) overlapInReturned += 1;
        }
        const bm25OnlyContribution = Math.max(0, bm25Total - overlapInReturned);
        repoTotal += bm25OnlyContribution;
      }
      totalVectorCount += vectorRows.length;
      totalBm25Count += bm25Rows.length;

      const fused = reciprocalRankFusion(vectorRows, bm25Rows, { k: RRF_K, cap: rerankTopN });
      fusedAll.push(...fused);
      // Engaged-path semantics for `mode`: when bm25 was enabled and we
      // *issued* the BM25 query, the repo is in 'hybrid' mode even if 0
      // rows matched. 'vector_only' is reserved for repos where the BM25
      // branch was skipped entirely (operator escape, empty escaped query,
      // FTS5 unavailable, or bm25Only test seam). Aligns with TS-005.
      //
      // F2: `bm25Count` is the actual number of BM25 rows the retriever
      // got for this repo on this call. It exposes the contribution signal
      // that the bare 'hybrid' string used to hide — consumers wanting to
      // detect engaged-but-empty BM25 can now check `bm25Count === 0`
      // without breaking the engaged-path `mode` semantic.
      perRepoMode[r] = {
        mode: bm25Enabled ? 'hybrid' : 'vector_only',
        bm25Count: bm25Rows.length,
      };
    }
    // Cross-repo merge: sort by RRF score desc, cap at rerankTopN.
    fusedAll.sort((a, b) => b.rrfScore - a.rrfScore);
    if (fusedAll.length > rerankTopN) {
      fusedAll.length = rerankTopN;
      truncated = true;
    }
    log.metric('hybrid_fusion_ms', Date.now() - fusionT0, {});

    // Determine top-level hybrid mode envelope.
    const modes = new Set(Object.values(perRepoMode).map((v) => v.mode));
    let hybridMode: 'hybrid' | 'vector_only' | 'partial' = 'vector_only';
    if (bm25OnlyTest) {
      hybridMode = 'vector_only'; // bm25-only is still single-path semantics
    } else if (modes.size === 1) {
      hybridMode = modes.has('hybrid') ? 'hybrid' : 'vector_only';
    } else if (modes.size > 1) {
      hybridMode = 'partial';
    }

    // Pull out the underlying chunks for the rerank pass, preserving fusion
    // metadata for the final response shape.
    const allCandidates: QueryResult[] = fusedAll.map((f) => {
      const chunk = f.chunk as QueryResult;
      // Synthesize a stable cosine-like score on BM25-only candidates (vector
      // score = 0 since no vector entry). The reranker pass below replaces
      // this; the vectorScore field on each RetrievedChunk preserves the
      // genuine cosine when present (null otherwise).
      if (f.vectorScore == null) {
        return { ...chunk, score: 0 } as QueryResult;
      }
      return { ...chunk, score: f.vectorScore } as QueryResult;
    });
    const truncatedTotal = Math.min(repoTotal, rerankTopN);

    // ---- Reranker pass ----
    let rerankScores: number[] | null = null;
    let degraded = false;
    let degradedReason: string | undefined;
    let degradedStatus: 'retry' | undefined;
    try {
      rerankScores = await this.deps.reranker.score(
        query,
        allCandidates.map((c) => c.text),
      );
      if (rerankScores.length !== allCandidates.length) {
        throw new RerankerError(
          'score_failed',
          `reranker returned ${rerankScores.length} scores for ${allCandidates.length} candidates`,
        );
      }
    } catch (err) {
      degraded = true;
      rerankScores = null;
      if (err instanceof RerankerError) {
        degradedReason = `reranker ${err.kind}: ${err.message}`;
        if (err.kind === 'download_failed' || err.kind === 'download_timeout') {
          degradedStatus = 'retry';
        }
        log.warn('retriever.rerank_degraded', { kind: err.kind, message: err.message });
      } else {
        const reason = err instanceof Error ? err.message : String(err);
        degradedReason = `reranker unknown: ${reason}`;
        log.warn('retriever.rerank_degraded', { kind: 'unknown', message: reason });
      }
    }

    // Apply rerank ordering (or fall back to fusion ordering on degraded).
    // v2.7: each ordered entry carries the FusedResult fields so per-chunk
    // hybrid metadata (vectorRank, bm25Rank, rrfScore, bm25Score) survives
    // through the rerank pass.
    let ordered: Array<{
      row: QueryResult;
      fused: FusedResult;
      vectorScore: number | null;
      rerankScore: number | null;
    }>;
    if (rerankScores) {
      ordered = allCandidates.map((row, i) => ({
        row,
        fused: fusedAll[i],
        vectorScore: fusedAll[i].vectorScore,
        rerankScore: rerankScores[i],
      }));
      ordered.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
    } else {
      ordered = allCandidates.map((row, i) => ({
        row,
        fused: fusedAll[i],
        vectorScore: fusedAll[i].vectorScore,
        rerankScore: null,
      }));
      // Already sorted by RRF score above (fusedAll order preserved).
    }

    // ---- Pagination contract ----
    // Happy path: total = truncatedTotal (caps at rerankTopN), repoTotal full.
    // Degraded path (Codex high fix): the vector layer ALREADY truncated to
    // rerankTopN candidates above (perf-bounded). Returning total = repoTotal
    // here would mis-advertise unreachable pagination — slice space is bounded
    // by the candidate set we held. Stay honest: total = truncatedTotal,
    // truncated reflects whether we capped (same as happy path). The
    // `degraded` envelope field signals the ordering-quality drop separately
    // from the pagination shape.
    const total = truncatedTotal;

    // v2.7: hybridStats audit field — built once per call.
    const hybridStats = {
      rrfK: RRF_K,
      vectorCount: totalVectorCount,
      bm25Count: totalBm25Count,
      fusedCount: fusedAll.length,
      perRepo: perRepoMode,
    };

    // Compose envelope reason: degradedReason (rerank) takes precedence; if
    // no rerank degradation, surface the forced-vector-only reason when set.
    const envelopeReason = degradedReason ?? forcedVectorOnlyReason ?? undefined;

    // Offset beyond rerank window: empty slice + warn-log. Applies to BOTH
    // happy and degraded paths now that degraded honestly reflects the cap.
    //
    // PSF-002 unification: the `truncated` value returned here MUST be the
    // same as the happy-path return (line ~398) — both are derived from the
    // single `truncated` variable set inside the per-repo loop (line ~192)
    // AND the cross-repo merge (line ~223). The previous independent formula
    // `truncated: repoTotal > rerankTopN` diverged from the loop-set value
    // on corner cases (cross-repo BM25-heavy fixtures where per-repo
    // vectorTotal stays ≤ rerankTopN but cross-repo fusedAll overflows). One
    // authoritative source removes that drift.
    // PSF-004 layer 2: defense-in-depth before serialize. Even with the
    // indexer's layer-1 guard, stored chunks from a pre-fix build may
    // carry empty commitSha. Validate at the boundary: if any candidate
    // about to be rendered has an invalid SHA, return a structured
    // `status: 'retry'` envelope instead of letting the SerializerError
    // (layer 3) propagate as a thrown exception.
    for (const entry of ordered) {
      if (!/^[0-9a-f]{40}$/.test(entry.row.commitSha)) {
        log.warn('retriever.empty_commit_sha', {
          repo: entry.row.repo,
          sectionSlug: entry.row.sectionSlug,
          commitSha: entry.row.commitSha,
        });
        return {
          chunks: [],
          truncated: false,
          total: 0,
          status: 'retry',
          retryAfterSeconds: 60,
          reason: 'empty_commit_sha: stored chunk has invalid citation.commitSha; reindex required',
        };
      }
    }

    if (offset >= ordered.length) {
      log.warn('retriever.offset_beyond_rerank_window', { offset, rerankTopN, truncatedTotal, degraded });
      return {
        chunks: [],
        truncated,
        total,
        repoTotal,
        hybrid: hybridMode,
        hybridStats,
        ...(degraded ? { degraded: true } : {}),
        ...(degradedStatus ? { status: degradedStatus } : {}),
        ...(degradedStatus ? { retryAfterSeconds: 60 } : {}),
        ...(envelopeReason ? { reason: envelopeReason } : {}),
      };
    }

    const top = ordered.slice(offset, offset + k);
    const chunks: RetrievedChunk[] = top.map((entry) => {
      const c = entry.row;
      const sourceUrl = `${CODEWIKI_BASE_URL}${c.repo}#${c.sectionSlug}`;
      const citation: Citation = {
        sourceUrl,
        commitSha: c.commitSha,
        lastChecked: new Date().toISOString(),
      };
      const text = renderWithCitation(c.text, citation, c.sectionSlug);
      return {
        repo: c.repo,
        pageSlug: c.pageSlug,
        sectionSlug: c.sectionSlug,
        ordinal: c.ordinal,
        // score = rerank if available, else vectorScore (preserves
        // v2.5-compatible callers on the degraded path), else bm25Score
        // (BM25-only candidate), else RRF (both unset shouldn't happen).
        score:
          entry.rerankScore ??
          entry.vectorScore ??
          entry.fused.bm25Score ??
          entry.fused.rrfScore,
        vectorScore: entry.vectorScore,
        rerankScore: entry.rerankScore,
        bm25Score: entry.fused.bm25Score,
        bm25Rank: entry.fused.bm25Rank,
        vectorRank: entry.fused.vectorRank,
        rrfScore: entry.fused.rrfScore,
        text,
        citation,
      };
    });

    // v2.6: stamp the reranker fingerprint once per process after first
    // successful rerank. Audit-only — does NOT trigger chunk drop.
    if (!degraded) {
      this.maybeStampRerankerFingerprint();
    }

    return {
      chunks,
      truncated,
      total,
      repoTotal,
      hybrid: hybridMode,
      hybridStats,
      ...(degraded ? { degraded: true } : {}),
      ...(degradedStatus ? { status: degradedStatus } : {}),
      ...(degradedStatus ? { retryAfterSeconds: 60 } : {}),
      ...(envelopeReason ? { reason: envelopeReason } : {}),
    };
  }

  /**
   * v2.6 audit hook: stamp `meta.rerank_model` once per Retriever lifetime
   * after the first successful rerank. Audit-only — does NOT trigger chunk
   * drop on swap.
   */
  private rerankerFingerprintStamped = false;
  private maybeStampRerankerFingerprint(): void {
    if (this.rerankerFingerprintStamped) return;
    this.rerankerFingerprintStamped = true;
    const cache = this.deps.cache;
    if (!cache) return;
    const fp = this.deps.reranker.getFingerprint();
    const current = cache.getRerankModel();
    if (current !== fp.model) {
      cache.setRerankModel(fp.model);
      getLogger().info('reranker.fingerprint_stamped', { model: fp.model, previous: current });
    }
  }

  /**
   * Decide which repos to query against. For a single-repo call, race the
   * indexer's promise against `timeoutMs`. For an omitted-repo call, return
   * the set of repos that already have a fresh index.
   */
  private async resolveTargetRepos(
    repo: string | undefined,
    timeoutMs: number,
  ): Promise<{ repos: string[] } | FindChunksResult> {
    if (repo) {
      let buildPromise: Promise<IndexerResult>;
      try {
        buildPromise = this.deps.indexer.indexRepo(repo);
      } catch (err) {
        if (err instanceof EmbedderError) {
          return {
            chunks: [],
            truncated: false, total: 0,
            status: 'retry',
            retryAfterSeconds: 60,
            reason: `embedder ${err.kind}: ${err.message}`,
          };
        }
        throw err;
      }
      const raced = await Promise.race([
        buildPromise.then(
          (r) => ({ kind: 'done' as const, result: r }),
          (err: unknown) => ({ kind: 'error' as const, err }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs),
        ),
      ]);
      if (raced.kind === 'timeout') {
        return { chunks: [], truncated: false, total: 0, status: 'index_building' };
      }
      if (raced.kind === 'error') {
        if (raced.err instanceof EmbedderError) {
          return {
            chunks: [],
            truncated: false, total: 0,
            status: 'retry',
            retryAfterSeconds: 60,
            reason: `embedder ${raced.err.kind}: ${raced.err.message}`,
          };
        }
        throw raced.err;
      }
      const r: IndexerResult = raced.result;
      if (r.status === 'no_docs') {
        return { chunks: [], truncated: false, total: 0, status: 'no_docs', fallbacks: r.fallbacks };
      }
      if (r.status === 'rate_limited') {
        return { chunks: [], truncated: false, total: 0, status: 'rate_limited', retryAfterSeconds: r.retryAfterSeconds };
      }
      if (r.status === 'retry') {
        return {
          chunks: [],
          truncated: false, total: 0,
          status: 'retry',
          retryAfterSeconds: r.retryAfterSeconds,
          reason: r.reason,
        };
      }
      // ready
      return { repos: [repo] };
    }
    // No repo: only query already-indexed repos that are still FRESH.
    // Stale indexes are excluded (no implicit refetch — that's the plan's
    // contract for the omitted-repo branch). TTL is INDEX_TTL_MS.
    const now = Date.now();
    const allIndexed = this.deps.store.listIndexedRepos();
    const fresh = allIndexed.filter((r) => {
      const status = this.deps.store.getWikiIndexStatus(r);
      return status !== null && now - status.indexedAt < INDEX_TTL_MS;
    });
    return { repos: fresh.slice(0, CROSS_REPO_CAP) };
  }
}

/**
 * Render a chunk's stored text plus the canonical citation footer.
 * Strips any pre-existing footer from the input first to prevent doubling.
 */
function renderWithCitation(rawText: string, citation: Citation, _sectionSlug: string): string {
  const cleaned = stripExistingFooter(rawText);
  // serialize() adds the canonical footer. We pass a single ProseNode whose
  // markdown is the cleaned chunk text. The output is byte-equal to the v1
  // citation contract (CITATION_FOOTER_REGEX matches).
  const result = serialize(
    [{ type: 'prose', sectionSlug: _sectionSlug, markdown: cleaned }],
    citation,
    { maxTokens: Number.MAX_SAFE_INTEGER },
  );
  return result.markdown;
}

function stripExistingFooter(text: string): string {
  const match = CITATION_FOOTER_REGEX.exec(text);
  if (!match) return text;
  // The regex anchors at $ — strip the matched suffix. Recompute via lastIndex.
  const idx = text.lastIndexOf(match[0]);
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
}
