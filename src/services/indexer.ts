/**
 * Indexer — issues ONE getPage(repo) per repo, chunks the canonical tree,
 * embeds chunks in batches, extracts knowledge-graph edges (v2.1) and writes
 * everything to the cache in ONE atomic transaction.
 *
 * Per-repo single-flight: concurrent callers collapse into one build.
 *
 * Freshness contract (mirrors v1's pages cache contract):
 *   - wiki_index_status.indexed_at fresh (< INDEX_TTL_MS): return ready, no work.
 *   - Expired with same commit_sha: refresh indexed_at only, no re-embed.
 *   - Expired with changed commit_sha (or cache miss): full rebuild.
 *
 * The repo-wide index SHA is sourced from `cache.getPage(repo, '__root__').commitSha`
 * — the v1 cache pins commit_sha per page on every full fetch (see
 * src/services/codewiki_client.ts:166,183). The wiki_status table does NOT
 * carry commit_sha; reading from getPage is the authoritative path.
 *
 * v2.1 KG additions:
 *   - `IndexerBuildOptions { buildChunks?, buildGraph? }` lets the test seam
 *     skip either side of the build. Production NEVER passes `buildGraph: false`
 *     except via the `CODEWIKI_DISABLE_KG=1` env-var rollback escape hatch
 *     (which also unregisters `find_neighbors` in `buildServer`, so the
 *     surface and behavior stay consistent).
 *   - The atomic transaction covers chunk writes AND graph-edge writes; on
 *     the in-memory backend the transaction is a no-op (best-effort sequential
 *     writes — documented in the v2.1 KG plan's Risks table).
 */

import { getLogger } from '../logging.js';
import { Cache } from './cache.js';
import { CodeWikiClient } from './codewiki_client.js';
import { Embedder } from '../adapters/embedder.js';
import { VectorStore } from './vector_store.js';
import { GraphStore } from './graph_store.js';
import { chunkPage } from '../extraction/chunker.js';
import { extractEdges } from './graph_extractor.js';
import type { Chunk, Fallback, IndexedChunk, KgEdge } from '../types.js';
import {
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  INDEX_TTL_MS,
} from '../config_rag.js';

export type IndexerReady = { status: 'ready'; chunkCount: number; edgeCount?: number };
export type IndexerNoDocs = { status: 'no_docs'; fallbacks: Fallback[] };
export type IndexerRateLimited = { status: 'rate_limited'; retryAfterSeconds: number };
export type IndexerRetry = { status: 'retry'; retryAfterSeconds: number; reason: string };

export type IndexerResult = IndexerReady | IndexerNoDocs | IndexerRateLimited | IndexerRetry;

export interface IndexerDeps {
  client: CodeWikiClient;
  embedder: Embedder;
  store: VectorStore;
  graphStore: GraphStore;
  cache: Cache;
}

export interface IndexerBuildOptions {
  buildChunks?: boolean;
  buildGraph?: boolean;
}

const EMBED_BATCH_SIZE = 16;

/**
 * Read once at module load. Production toggles this to roll back v2.1 KG
 * without redeploying — when truthy, the indexer coerces buildGraph: false
 * regardless of caller opts AND `buildServer` skips registering the
 * `find_neighbors` tool, keeping the surface consistent.
 */
const KG_DISABLED = process.env.CODEWIKI_DISABLE_KG === '1';

/** Rolling window of recent successful build durations (ms). */
const ESTIMATE_WINDOW_SIZE = 10;
/** Cold-path default (ms) used when no successful build has been observed yet. */
const ESTIMATE_COLD_DEFAULT_MS = 8000;

export class Indexer {
  private readonly inflight = new Map<string, Promise<IndexerResult>>();
  /** Rolling window of recent successful build durations for estimateRemainingMs. */
  private readonly recentBuildMs: number[] = [];

  constructor(private readonly deps: IndexerDeps) {}

  /**
   * Lazy index for a repo. Returns the in-flight promise on concurrent calls
   * (single-flight) so the retriever can race it against a timeout.
   */
  indexRepo(repo: string, opts: IndexerBuildOptions = {}): Promise<IndexerResult> {
    const existing = this.inflight.get(repo);
    if (existing) return existing;

    const p = this.runIndex(repo, opts).finally(() => {
      this.inflight.delete(repo);
    });
    this.inflight.set(repo, p);
    return p;
  }

  /**
   * Estimated milliseconds remaining for an in-flight build, given the elapsed
   * wall-time so far. Rolling average over the last `ESTIMATE_WINDOW_SIZE`
   * successful builds; falls back to a cold-path default when no observations
   * exist. Clamped to >= 0.
   *
   * The Retriever surfaces `Math.ceil(estimateRemainingMs(...) / 1000)` as
   * `estimatedRemainingSeconds` on the `index_building` envelope so agents
   * can choose between waiting vs calling `request_indexing` for a future
   * cache hit.
   */
  estimateRemainingMs(elapsedMs: number): number {
    // Defensive clamp: negative elapsedMs (clock skew, mocked timers in tests)
    // would otherwise inflate the estimate beyond the avg.
    const e = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
    const avg = this.recentBuildMs.length === 0
      ? ESTIMATE_COLD_DEFAULT_MS
      : this.recentBuildMs.reduce((a, b) => a + b, 0) / this.recentBuildMs.length;
    return Math.max(0, Math.round(avg - e));
  }

  /** Test seam — pre-seed recent build durations. */
  __test_seedRecentBuildMs(values: number[]): void {
    this.recentBuildMs.length = 0;
    for (const v of values.slice(-ESTIMATE_WINDOW_SIZE)) this.recentBuildMs.push(v);
  }

  private async runIndex(repo: string, optsIn: IndexerBuildOptions): Promise<IndexerResult> {
    const log = getLogger();
    const now = Date.now();
    const buildStart = process.hrtime.bigint();

    // Coerce opts: defaults are both true; CODEWIKI_DISABLE_KG forces
    // buildGraph: false regardless of caller intent.
    const buildChunks = optsIn.buildChunks !== false;
    const buildGraph = !KG_DISABLED && optsIn.buildGraph !== false;

    // 1. Freshness check.
    const status = this.deps.store.getWikiIndexStatus(repo);
    if (status && now - status.indexedAt < INDEX_TTL_MS) {
      // Hit, fresh. Defense-in-depth: if buildGraph was requested AND the
      // status row claims an empty graph (edgeCount === -1 sentinel),
      // continue past the early-return so the build runs and populates
      // edges. Without this, a row written before v2.1 (no edge_count) or
      // by a `{ buildGraph: false }` test would shadow legitimate KG calls.
      if (!buildGraph || status.edgeCount >= 0) {
        return { status: 'ready', chunkCount: status.chunkCount, edgeCount: status.edgeCount };
      }
    }

    // 2. Fetch the repo's canonical tree (single getPage call). v1's
    //    defaultFetchPage at src/services/codewiki_client.ts:230-246 always
    //    navigates to ${CODEWIKI_BASE_URL}${repo} — there is no per-page
    //    fetch API. PageIndex entries are headings, NOT separate pages.
    const pageResult = await this.deps.client.getPage(repo);
    if ('status' in pageResult) {
      // no_docs / rate_limited / retry — pass through verbatim.
      if (pageResult.status === 'no_docs') {
        return { status: 'no_docs', fallbacks: pageResult.fallbacks };
      }
      if (pageResult.status === 'rate_limited') {
        return { status: 'rate_limited', retryAfterSeconds: pageResult.retryAfterSeconds };
      }
      if (pageResult.status === 'retry') {
        return {
          status: 'retry',
          retryAfterSeconds: pageResult.retryAfterSeconds,
          reason: pageResult.reason,
        };
      }
      // F1: `no_match` cannot fire here in practice — indexer calls
      // `getPage(repo)` with neither slug nor subsection, so the heading
      // validator's two preconditions (pageSlug !== '__root__'  OR
      // subsection != null) are both false. Branch present for exhaustive
      // narrowing + defense-in-depth: if a future caller widens this call
      // site, degrade to a recoverable retry envelope rather than leaking
      // a no_match envelope through indexer's contract.
      log.warn('indexer.unexpected_no_match', { repo });
      return {
        status: 'retry',
        retryAfterSeconds: 30,
        reason: 'unexpected no_match envelope from getPage(root)',
      };
    }

    // 3. Read the authoritative commit SHA from the cached page row.
    const cachedPage = this.deps.cache.getPage(repo, '__root__');
    const upstreamSha = cachedPage?.commitSha ?? pageResult.citation.commitSha ?? '';

    // PSF-004 layer 1: reject empty/malformed SHA upstream. Without this
    // guard, an empty SHA would propagate into chunks AND into citation
    // footers, silently breaking the byte-equal CITATION_FOOTER_REGEX
    // contract. Map to a recoverable `status: 'retry'` so the client
    // sees a structured failure instead of a corrupted response.
    if (!/^[0-9a-f]{40}$/.test(upstreamSha)) {
      log.warn('indexer.empty_commit_sha', { repo, upstreamSha });
      return {
        status: 'retry',
        retryAfterSeconds: 60,
        reason: `empty_commit_sha: upstream page returned commitSha=${JSON.stringify(upstreamSha)} which is not a 40-char hex SHA`,
      };
    }

    // 4. Same-SHA refresh path (TTL expired but content unchanged).
    if (status && status.commitSha === upstreamSha && upstreamSha.length > 0) {
      // Same SHA AND graph build was requested AND status says graph is
      // missing → full rebuild (don't refresh-only with an empty graph).
      if (buildGraph && status.edgeCount < 0) {
        // fall through to full rebuild
      } else {
        this.deps.store.upsertWikiIndexStatus(repo, upstreamSha, status.chunkCount, status.edgeCount);
        log.info('indexer.refresh', { repo, sha: upstreamSha, chunkCount: status.chunkCount, edgeCount: status.edgeCount });
        return { status: 'ready', chunkCount: status.chunkCount, edgeCount: status.edgeCount };
      }
    }

    // 5. Full (re-)index.
    const chunks = buildChunks
      ? chunkPage(repo, '__root__', pageResult.nodes, {
          maxTokens: CHUNK_MAX_TOKENS,
          overlapTokens: CHUNK_OVERLAP_TOKENS,
        })
      : [];

    const edgesRaw: KgEdge[] = buildGraph ? extractEdges(repo, pageResult.nodes) : [];
    const edges: KgEdge[] = edgesRaw.map((e) => ({ ...e, commitSha: upstreamSha, indexedAt: now }));

    if (chunks.length === 0 && edges.length === 0) {
      // Empty tree — write an empty index status so subsequent calls skip.
      this.deps.store.dropRepo(repo);
      if (buildGraph) this.deps.graphStore.dropForRepo(repo);
      const edgeCountForStatus = buildGraph ? 0 : -1;
      this.deps.store.upsertWikiIndexStatus(repo, upstreamSha, 0, edgeCountForStatus);
      return { status: 'ready', chunkCount: 0, edgeCount: buildGraph ? 0 : undefined };
    }

    const indexed: IndexedChunk[] = buildChunks
      ? await this.embedInBatches(chunks, upstreamSha, now)
      : [];

    // Atomic write: drop existing chunks/edges + write new ones + update
    // status in a single sqlite transaction. Prevents partial state on a
    // crash mid-write (e.g. graphStore.upsertEdges throws after
    // store.upsertChunks succeeded). better-sqlite3 honors BEGIN/COMMIT/
    // ROLLBACK; the in-memory store ignores them and runs writes
    // sequentially anyway (synchronous JS). Documented limitation: rollback
    // is best-effort on the in-memory backend.
    const sqlStore = this.deps.cache.getStore();
    let transactionStarted = false;
    try {
      sqlStore.exec('BEGIN');
      transactionStarted = true;
      if (buildChunks) {
        this.deps.store.dropRepo(repo);
        this.deps.store.upsertChunks(indexed);
      }
      if (buildGraph) {
        this.deps.graphStore.dropForRepo(repo);
        this.deps.graphStore.upsertEdges(edges);
      }
      const edgeCountForStatus = buildGraph ? edges.length : status?.edgeCount ?? -1;
      this.deps.store.upsertWikiIndexStatus(repo, upstreamSha, indexed.length, edgeCountForStatus);
      sqlStore.exec('COMMIT');
    } catch (err) {
      if (transactionStarted) {
        try {
          sqlStore.exec('ROLLBACK');
        } catch {
          /* rollback best-effort */
        }
      }
      throw err;
    }

    // v2.5: stamp the embedder fingerprint AFTER the COMMIT (outside the
    // transaction). Half-completed swap with the OLD fingerprint is the
    // correct retry-on-next-startup behavior — the next startup re-runs
    // the drop idempotently because chunks are already empty.
    if (buildChunks && indexed.length > 0) {
      const fp = this.deps.embedder.getFingerprint();
      this.deps.cache.setEmbedderFingerprint(fp.model, fp.dim);
    }

    // v2.5: emit index_build_ms metric on success (failure paths already
    // emit warn-level errors from the catch block above).
    const buildDurMs = Number((process.hrtime.bigint() - buildStart) / 1_000_000n);
    log.metric('index_build_ms', buildDurMs, {
      repo,
      chunkCount: indexed.length,
      ...(buildGraph ? { edgeCount: edges.length } : {}),
    });

    // Feed the rolling window so estimateRemainingMs adapts to this
    // deployment's actual cold-path latency.
    this.recentBuildMs.push(buildDurMs);
    if (this.recentBuildMs.length > ESTIMATE_WINDOW_SIZE) {
      this.recentBuildMs.shift();
    }

    log.info('indexer.built', {
      repo,
      sha: upstreamSha,
      chunkCount: indexed.length,
      ...(buildGraph ? { edgeCount: edges.length } : {}),
    });
    return {
      status: 'ready',
      chunkCount: indexed.length,
      ...(buildGraph ? { edgeCount: edges.length } : {}),
    };
  }

  private async embedInBatches(chunks: Chunk[], commitSha: string, indexedAt: number): Promise<IndexedChunk[]> {
    const out: IndexedChunk[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      const vectors = await this.deps.embedder.encode(texts);
      for (let j = 0; j < batch.length; j++) {
        out.push({
          ...batch[j],
          embedding: vectors[j],
          indexedAt,
          commitSha,
        });
      }
    }
    return out;
  }
}

export function buildIndexer(deps: IndexerDeps): Indexer {
  return new Indexer(deps);
}
