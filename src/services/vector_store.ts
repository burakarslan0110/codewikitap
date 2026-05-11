/**
 * VectorStore — wraps the cache.db `chunks` and `wiki_index_status` tables.
 *
 * Two execution paths:
 *   - Native (better-sqlite3) + sqlite-vec extension: cosine ranking via
 *     `vec_distance_cosine` against the `vec_chunks(float[N])` virtual table.
 *     INNER JOIN'd on rowid against `chunks`. v2.6 wires this in; the v6
 *     migration backfilled `vec_chunks` from existing `chunks` rows.
 *   - Pure-JS cosine: scan all chunks for the requested repo, compute cosine
 *     similarity in Node, sort, return top-k. Used for the in-memory backend
 *     AND when sqlite-vec failed to load at runtime (e.g., macOS SIP) AND
 *     when `CODEWIKI_FORCE_PUREJS_VECTOR=1` for tests.
 *
 * Embeddings are stored as Float32Array bytes:
 *   - Native: BLOB column populated with `Buffer.from(float32.buffer, ...)`.
 *   - In-memory cache: the simple SQL parser stores values verbatim; we pass
 *     the Float32Array reference directly.
 *
 * Dual-write contract (v2.6): every successful `upsertChunks` writes to
 * BOTH `chunks` AND `vec_chunks` when `hasSqliteVec === true`. The rowid
 * captured from the chunks INSERT is reused as the vec_chunks rowid, so an
 * INNER JOIN on rowid produces parity. `dropRepo` and `dropAllChunks` clean
 * both tables in the same transaction. Dim mismatch (chunk embedding length
 * != configured EMBED_MODEL_DIM) THROWS — production model swaps are caught
 * here, and the dim-swap auto-reindex hook handles the recreate flow.
 */

import { getLogger } from '../logging.js';
import type { Cache } from './cache.js';
import type { IndexedChunk } from '../types.js';
import { EMBED_MODEL_DIM, FORCE_PUREJS_VECTOR } from '../config_rag.js';

export interface QueryResult extends IndexedChunk {
  /** Cosine similarity in [0, 1] (vectors are L2-normalized). */
  score: number;
}

/**
 * v2.7: BM25 retrieval result. Mirrors `QueryResult` shape so the
 * fusion module can dedupe and combine the two ranked lists by composite
 * PK. `score` is the INVERTED BM25 score (higher = better match), since
 * SQLite's `bm25()` aux function returns values in `(-∞, 0]` (more
 * negative = better). The inversion happens in `queryChunksBM25` before
 * returning so callers never see the negative scale.
 */
export interface BM25QueryResult extends IndexedChunk {
  /** Inverted BM25 score (higher = better). Always > 0 for matched rows. */
  score: number;
}

export interface WikiIndexStatus {
  repo: string;
  indexedAt: number;
  commitSha: string;
  chunkCount: number;
  /**
   * Number of KG edges persisted for this repo at index time.
   * Set by the v2.1 indexer when buildGraph !== false; reads as -1 (sentinel
   * meaning "graph never built for this row") on v2-shape rows that pre-date
   * the column addition.
   */
  edgeCount: number;
}

export class VectorStore {
  private readonly cache: Cache;
  private readonly inMemory: boolean;
  private readonly purejs: boolean;
  /**
   * v2.6: true when the native vec_chunks query+upsert path is engaged.
   * = !inMemory && !FORCE_PUREJS_VECTOR && cache.vecAvailable.
   * Read once at construction; constant for the instance's lifetime.
   */
  private readonly _hasSqliteVec: boolean;
  /**
   * v2.7: true when the FTS5 BM25 query+upsert path is engaged.
   * = !inMemory && cache.ftsAvailable && !CODEWIKI_FORCE_NO_BM25.
   * Read once at construction. Independent of `_hasSqliteVec` — purejs
   * vector mode does NOT disable BM25.
   */
  private readonly _hasFts5: boolean;
  /** v2.7: operator escape — CODEWIKI_FORCE_NO_BM25=1 disables BM25. */
  private readonly _forceNoBm25: boolean;

  constructor(cache: Cache) {
    this.cache = cache;
    this.inMemory = cache.isInMemory;
    // Read env at construction (not at module load) so tests can flip the
    // FORCE_PUREJS_VECTOR override per test case via process.env.
    const envOverride = process.env.CODEWIKI_FORCE_PUREJS_VECTOR === '1';
    this.purejs = FORCE_PUREJS_VECTOR || envOverride;
    this._hasSqliteVec = !this.inMemory && !this.purejs && cache.vecAvailable;

    this._forceNoBm25 = process.env.CODEWIKI_FORCE_NO_BM25 === '1';
    this._hasFts5 = !this.inMemory && cache.ftsAvailable && !this._forceNoBm25;

    const log = getLogger();
    if (this._hasSqliteVec) {
      log.info('vector_store.sqlite_vec_engaged', { dim: EMBED_MODEL_DIM });
    } else if (!this.inMemory && !this.purejs && !cache.vecAvailable) {
      log.warn('vector_store.sqlite_vec_unavailable', {
        reason: 'cache.vecAvailable=false (load failed or v6 migration aborted) — pure-JS path engaged',
      });
    }
    if (this._hasFts5) {
      log.info('vector_store.fts5_engaged', {});
    } else if (!this.inMemory && !this._forceNoBm25 && !cache.ftsAvailable) {
      log.warn('vector_store.fts5_unavailable', {
        reason: 'cache.ftsAvailable=false (probe or v7 migration failed) — vector-only path engaged',
      });
    } else if (this._forceNoBm25) {
      log.info('vector_store.fts5_force_disabled', { reason: 'CODEWIKI_FORCE_NO_BM25=1' });
    }
  }

  /**
   * v2.7: true when the retriever should issue BM25 queries (FTS5 available
   * AND operator escape not set AND not in-memory). The Retriever consults
   * this to decide whether to engage the hybrid path.
   */
  hasBm25(): boolean {
    return this._hasFts5;
  }

  /**
   * Insert or replace chunks. The (repo, page_slug, section_slug, ordinal) PK
   * guards uniqueness. v2.6: when `hasSqliteVec`, also writes to `vec_chunks`
   * with the rowid captured from the chunks INSERT — INNER JOIN on rowid
   * yields parity. Dim mismatch (chunk embedding length != EMBED_MODEL_DIM)
   * throws so production model swaps are caught loudly.
   */
  upsertChunks(chunks: IndexedChunk[]): void {
    const store = this.cache.getStore();
    const chunksStmt = store.prepare(
      'INSERT OR REPLACE INTO chunks (repo, page_slug, section_slug, ordinal, text, github_repo, github_sha, github_path, github_line_range, embedding, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const vecStmt = this._hasSqliteVec
      ? store.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)')
      : null;
    const vecDeleteStmt = this._hasSqliteVec
      ? store.prepare('DELETE FROM vec_chunks WHERE rowid = ?')
      : null;
    // v2.7: FTS5 tri-write. FTS5 does NOT support `INSERT OR REPLACE` so
    // we delete-then-insert. Tri-write is gated on cache.ftsAvailable (not
    // on `_hasFts5` — operator escape disables QUERIES but writes should
    // still maintain parity so escape can be lifted at runtime in a future
    // session without re-indexing).
    const ftsEnabled = !this.inMemory && this.cache.ftsAvailable;
    const ftsStmt = ftsEnabled
      ? store.prepare('INSERT INTO fts_chunks (rowid, text) VALUES (?, ?)')
      : null;
    const ftsDeleteStmt = ftsEnabled
      ? store.prepare('DELETE FROM fts_chunks WHERE rowid = ?')
      : null;

    for (const c of chunks) {
      const embeddingValue = this.encodeEmbedding(c.embedding);
      const result = chunksStmt.run(
        c.repo,
        c.pageSlug,
        c.sectionSlug,
        c.ordinal,
        c.text,
        c.github?.repo ?? null,
        c.github?.sha ?? null,
        c.github?.path ?? null,
        c.github?.lineRange ?? null,
        embeddingValue,
        c.indexedAt,
        c.commitSha,
      );

      // Shared rowid for vec_chunks + fts_chunks tri-write.
      let sharedRowid: bigint | null = null;
      if ((vecStmt && vecDeleteStmt) || (ftsStmt && ftsDeleteStmt)) {
        const lastInsertRowid = (result as unknown as { lastInsertRowid: bigint | number }).lastInsertRowid;
        sharedRowid = typeof lastInsertRowid === 'bigint' ? lastInsertRowid : BigInt(Number(lastInsertRowid));
      }

      if (vecStmt && vecDeleteStmt) {
        if (c.embedding.length !== EMBED_MODEL_DIM) {
          throw new Error(
            `vector_store.upsertChunks: chunk embedding length ${c.embedding.length} != EMBED_MODEL_DIM ${EMBED_MODEL_DIM}; trigger embedder fingerprint auto-reindex first`,
          );
        }
        // INSERT OR REPLACE on chunks may produce a fresh rowid on conflict
        // delete-and-reinsert; vec_chunks doesn't share the chunks PK, so
        // delete any existing vec row at this rowid before inserting.
        vecDeleteStmt.run(sharedRowid!);
        const buf = Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength);
        vecStmt.run(sharedRowid!, buf);
      }

      // v2.7: FTS5 tri-write — delete-then-insert (FTS5 has no INSERT OR
      // REPLACE). Same rowid as the chunks row so the rowid INNER JOIN
      // produces parity.
      if (ftsStmt && ftsDeleteStmt) {
        ftsDeleteStmt.run(sharedRowid!);
        ftsStmt.run(sharedRowid!, c.text);
      }
    }
  }

  /** Top-k chunks for `repo` ranked by cosine similarity (higher is better). */
  queryChunks(repo: string, queryVec: Float32Array, k: number): QueryResult[] {
    return this.queryChunksPaged(repo, queryVec, 0, k).rows;
  }

  /**
   * v2.5: paged variant returning the requested slice AND the total
   * number of scored rows for the repo. Codex high fix #2 — v2.4's
   * `queryChunks(repo, vec, k)` returned at most k rows per repo, so
   * `total = k` and `offset >= k` always returned empty. The paged
   * variant scores ALL rows (same O(N log N) cost as v2.4) and exposes
   * the honest total + the requested page.
   */
  queryChunksPaged(
    repo: string,
    queryVec: Float32Array,
    offset: number,
    k: number,
  ): { rows: QueryResult[]; total: number } {
    if (this._hasSqliteVec) {
      return this.queryChunksPagedNative(repo, queryVec, offset, k);
    }
    return this.queryChunksPagedPureJs(repo, queryVec, offset, k);
  }

  /**
   * v2.6 native path: cosine ranking via `vec_distance_cosine` against the
   * `vec_chunks` virtual table, INNER JOIN'd with `chunks` on rowid. Total
   * is computed via a separate COUNT query so the ORDER BY + LIMIT can be
   * pushed into SQLite. Distance → score = 1 - distance.
   */
  private queryChunksPagedNative(
    repo: string,
    queryVec: Float32Array,
    offset: number,
    k: number,
  ): { rows: QueryResult[]; total: number } {
    const store = this.cache.getStore();
    const totalRow = store
      .prepare('SELECT count(*) AS n FROM chunks WHERE repo = ?')
      .get(repo);
    const total = totalRow ? Number(totalRow.n) : 0;
    if (total === 0) return { rows: [], total: 0 };

    const safeOffset = Math.max(0, offset);
    const safeK = Math.max(0, k);
    if (safeK === 0) return { rows: [], total };

    const queryBuf = Buffer.from(queryVec.buffer, queryVec.byteOffset, queryVec.byteLength);
    const sqlRows = store
      .prepare(
        'SELECT chunks.repo, chunks.page_slug, chunks.section_slug, chunks.ordinal, chunks.text, ' +
          'chunks.github_repo, chunks.github_sha, chunks.github_path, chunks.github_line_range, ' +
          'chunks.embedding, chunks.indexed_at, chunks.commit_sha, ' +
          'vec_distance_cosine(vec_chunks.embedding, ?) AS distance ' +
          'FROM chunks JOIN vec_chunks ON vec_chunks.rowid = chunks.rowid ' +
          'WHERE chunks.repo = ? ORDER BY distance ASC LIMIT ? OFFSET ?',
      )
      .all(queryBuf, repo, safeK, safeOffset);

    const rows: QueryResult[] = sqlRows.map((row) => {
      const embedding = this.decodeEmbedding(row.embedding);
      const distance = Number(row.distance);
      const result: QueryResult = {
        repo: String(row.repo),
        pageSlug: String(row.page_slug),
        sectionSlug: String(row.section_slug),
        ordinal: Number(row.ordinal),
        text: String(row.text),
        embedding,
        indexedAt: Number(row.indexed_at),
        commitSha: String(row.commit_sha),
        score: 1 - distance,
      };
      if (row.github_repo && row.github_sha && row.github_path) {
        result.github = {
          repo: String(row.github_repo),
          sha: String(row.github_sha),
          path: String(row.github_path),
          lineRange: row.github_line_range ? String(row.github_line_range) : undefined,
        };
      }
      return result;
    });
    return { rows, total };
  }

  /** v2.5 pure-JS cosine path — preserved verbatim for in-memory + force-purejs paths. */
  private queryChunksPagedPureJs(
    repo: string,
    queryVec: Float32Array,
    offset: number,
    k: number,
  ): { rows: QueryResult[]; total: number } {
    const rows = this.fetchRowsForRepo(repo);
    if (rows.length === 0) return { rows: [], total: 0 };

    const scored: QueryResult[] = rows.map((row) => {
      const embedding = this.decodeEmbedding(row.embedding);
      const score = cosineSim(queryVec, embedding);
      const chunk: QueryResult = {
        repo: String(row.repo),
        pageSlug: String(row.page_slug),
        sectionSlug: String(row.section_slug),
        ordinal: Number(row.ordinal),
        text: String(row.text),
        embedding,
        indexedAt: Number(row.indexed_at),
        commitSha: String(row.commit_sha),
        score,
      };
      if (row.github_repo && row.github_sha && row.github_path) {
        chunk.github = {
          repo: String(row.github_repo),
          sha: String(row.github_sha),
          path: String(row.github_path),
          lineRange: row.github_line_range ? String(row.github_line_range) : undefined,
        };
      }
      return chunk;
    });
    scored.sort((a, b) => b.score - a.score);
    const safeOffset = Math.max(0, offset);
    const sliceEnd = safeOffset + Math.max(0, k);
    return { rows: scored.slice(safeOffset, sliceEnd), total: scored.length };
  }

  /**
   * v2.7: BM25 retrieval over the FTS5 `fts_chunks` virtual table.
   * Returns `{ rows, total }` parallel to `queryChunksPaged`. `score` is
   * the INVERTED bm25 value (higher = better). Throws on empty query.
   */
  queryChunksBM25(repo: string, queryText: string, offset: number, k: number): { rows: BM25QueryResult[]; total: number } {
    if (!queryText.trim()) {
      throw new Error('vector_store.queryChunksBM25: non-empty query required');
    }
    if (!this._hasFts5) {
      return { rows: [], total: 0 };
    }
    const store = this.cache.getStore();
    const log = getLogger();
    const t0 = Date.now();

    const totalRow = store
      .prepare(
        'SELECT count(*) AS n FROM chunks JOIN fts_chunks ON fts_chunks.rowid = chunks.rowid WHERE chunks.repo = ? AND fts_chunks MATCH ?',
      )
      .get(repo, queryText);
    const total = totalRow ? Number(totalRow.n) : 0;
    if (total === 0) {
      log.metric('bm25_query_ms', Date.now() - t0, { repo, total_rows: 0 });
      return { rows: [], total: 0 };
    }

    const safeOffset = Math.max(0, offset);
    const safeK = Math.max(0, k);
    if (safeK === 0) {
      log.metric('bm25_query_ms', Date.now() - t0, { repo, total_rows: total });
      return { rows: [], total };
    }

    const sqlRows = store
      .prepare(
        'SELECT chunks.repo, chunks.page_slug, chunks.section_slug, chunks.ordinal, chunks.text, ' +
          'chunks.github_repo, chunks.github_sha, chunks.github_path, chunks.github_line_range, ' +
          'chunks.embedding, chunks.indexed_at, chunks.commit_sha, ' +
          'bm25(fts_chunks) AS bm25_raw ' +
          'FROM chunks JOIN fts_chunks ON fts_chunks.rowid = chunks.rowid ' +
          'WHERE chunks.repo = ? AND fts_chunks MATCH ? ORDER BY bm25_raw ASC LIMIT ? OFFSET ?',
      )
      .all(repo, queryText, safeK, safeOffset);

    const rows: BM25QueryResult[] = sqlRows.map((row) => {
      const embedding = this.decodeEmbedding(row.embedding);
      const bm25Raw = Number(row.bm25_raw);
      const result: BM25QueryResult = {
        repo: String(row.repo),
        pageSlug: String(row.page_slug),
        sectionSlug: String(row.section_slug),
        ordinal: Number(row.ordinal),
        text: String(row.text),
        embedding,
        indexedAt: Number(row.indexed_at),
        commitSha: String(row.commit_sha),
        // Invert sign: bm25() returns (-∞, 0] (negative = better). Negating
        // yields [0, +∞) where higher = better, matching cosine.
        score: -bm25Raw,
      };
      if (row.github_repo && row.github_sha && row.github_path) {
        result.github = {
          repo: String(row.github_repo),
          sha: String(row.github_sha),
          path: String(row.github_path),
          lineRange: row.github_line_range ? String(row.github_line_range) : undefined,
        };
      }
      return result;
    });

    log.metric('bm25_query_ms', Date.now() - t0, { repo, total_rows: total });
    return { rows, total };
  }

  /**
   * Remove all chunks for a repo (used by indexer before re-writing).
   * v2.6: also deletes the matching `vec_chunks` rows (rowid IN ...).
   * v2.7: also deletes the matching `fts_chunks` rows (rowid IN ...).
   */
  dropRepo(repo: string): void {
    const store = this.cache.getStore();
    // Delete fts_chunks BEFORE chunks — inner SELECT resolves against chunks.
    if (!this.inMemory && this.cache.ftsAvailable) {
      store
        .prepare('DELETE FROM fts_chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE repo = ?)')
        .run(repo);
    }
    if (this._hasSqliteVec) {
      store
        .prepare('DELETE FROM vec_chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE repo = ?)')
        .run(repo);
    }
    store.prepare('DELETE FROM chunks WHERE repo = ?').run(repo);
  }

  /**
   * v2.5: drop ALL chunks + wiki_index_status rows in one transaction.
   * v2.6 extension: when `recreateVecChunksDim` is provided, after deleting
   * all rows, DROP the `vec_chunks` virtual table and re-CREATE it with the
   * new `vec0(embedding float[<dim>])` schema. This handles the embedder
   * dim-swap path — without recreate, the old `float[384]` schema would
   * reject 768-dim writes from the new embedder, corrupting the auto-reindex
   * contract.
   *
   * KG edges (`kg_edges`) are NOT touched — graph extraction is symbolic +
   * model-independent. The freshness invariant for KG is the commit_sha on
   * `wiki_index_status`, so dropping that row alone forces a graph rebuild
   * on next access via the `edge_count < 0` sentinel branch.
   */
  dropAllChunks(opts: { recreateVecChunksDim?: number } = {}): void {
    const store = this.cache.getStore();
    // Iterate-per-repo so the WHERE-required in-memory store parser (see
    // src/adapters/sqlite_store.ts:158) handles deletes correctly. Wrap in
    // a transaction on the sqlite backend; the in-memory store ignores
    // BEGIN/COMMIT (no-op exec).
    const repos = this.listIndexedRepos();
    let txStarted = false;
    try {
      try { store.exec('BEGIN'); txStarted = true; } catch { /* no tx support */ }
      for (const r of repos) {
        // v2.7: clean fts_chunks first (same ordering rationale as dropRepo).
        if (!this.inMemory && this.cache.ftsAvailable) {
          store
            .prepare('DELETE FROM fts_chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE repo = ?)')
            .run(r);
        }
        if (this._hasSqliteVec) {
          store
            .prepare('DELETE FROM vec_chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE repo = ?)')
            .run(r);
        }
        store.prepare('DELETE FROM chunks WHERE repo = ?').run(r);
        store.prepare('DELETE FROM wiki_index_status WHERE repo = ?').run(r);
      }

      // v2.6 dim-swap: DROP+CREATE vec_chunks with the new dim BEFORE the
      // next insert. Inside the same transaction so a failure mid-recreate
      // rolls back cleanly.
      if (this._hasSqliteVec && typeof opts.recreateVecChunksDim === 'number') {
        const newDim = opts.recreateVecChunksDim;
        store.exec('DROP TABLE IF EXISTS vec_chunks');
        store.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${newDim}])`);
      }

      if (txStarted) store.exec('COMMIT');
    } catch (err) {
      if (txStarted) {
        try { store.exec('ROLLBACK'); } catch { /* best-effort */ }
      }
      throw err;
    }
  }

  /**
   * v2.5: returns true if EITHER `chunks` OR `wiki_index_status` has at
   * least one row. The startup hook uses this to distinguish a fresh
   * install (no fingerprint + empty index = no-op) from a legacy v2.4 DB
   * (no fingerprint + populated index = synthesize legacy default + run
   * mismatch detection). Codex critical fix #1.
   */
  hasAnyIndex(): boolean {
    const store = this.cache.getStore();
    const c = store.prepare('SELECT 1 AS x FROM chunks LIMIT 1').get();
    if (c) return true;
    const w = store.prepare('SELECT 1 AS x FROM wiki_index_status LIMIT 1').get();
    return Boolean(w);
  }

  /** Number of chunks currently stored for a repo. */
  chunkCountForRepo(repo: string): number {
    const rows = this.fetchRowsForRepo(repo);
    return rows.length;
  }

  /**
   * v2.5: fetch chunk text(s) for a single section in a repo. Used by
   * find_neighbors' semantic-rank branch to score each candidate section
   * neighbor against the query embedding. Returns the chunk texts in
   * `ordinal` order (a single section may produce multiple chunks).
   *
   * Returns [] when no chunks match — caller should fall back to v2.4
   * positional ordering for that neighbor (typically: file/repo neighbors
   * land at the bottom; missing-section neighbors stay in v2.4 order).
   */
  fetchChunkTextsForSection(repo: string, sectionSlug: string): string[] {
    const store = this.cache.getStore();
    const rows = store
      .prepare('SELECT text, ordinal FROM chunks WHERE repo = ? AND section_slug = ?')
      .all(repo, sectionSlug);
    rows.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    return rows.map((r) => String(r.text));
  }

  /**
   * Insert or update the wiki_index_status row for a repo.
   *
   * `edgeCount` is the v2.1 KG addition. Pass `-1` (the default) when only
   * chunks were built (callers never use this branch in production thanks
   * to the indexer's lifecycle invariant; tests pass it explicitly via the
   * `{ buildGraph: false }` test seam).
   */
  upsertWikiIndexStatus(repo: string, commitSha: string, chunkCount: number, edgeCount = -1): void {
    const store = this.cache.getStore();
    store
      .prepare(
        'INSERT OR REPLACE INTO wiki_index_status (repo, indexed_at, commit_sha, chunk_count, edge_count) VALUES (?, ?, ?, ?, ?)',
      )
      .run(repo, Date.now(), commitSha, chunkCount, edgeCount);
  }

  /** Read the wiki_index_status row for a repo, or null if missing. */
  getWikiIndexStatus(repo: string): WikiIndexStatus | null {
    const store = this.cache.getStore();
    const row = store
      .prepare('SELECT repo, indexed_at, commit_sha, chunk_count, edge_count FROM wiki_index_status WHERE repo = ?')
      .get(repo);
    if (!row) return null;
    // edge_count is null on v2-shape rows that pre-date the column; treat
    // null as the -1 sentinel so callers can do `status.edgeCount < 0`.
    const ec = row.edge_count;
    const edgeCount = ec === null || ec === undefined ? -1 : Number(ec);
    return {
      repo: String(row.repo),
      indexedAt: Number(row.indexed_at),
      commitSha: String(row.commit_sha),
      chunkCount: Number(row.chunk_count),
      edgeCount,
    };
  }

  /** All repos with a wiki_index_status row (i.e. that have an index). */
  listIndexedRepos(): string[] {
    const store = this.cache.getStore();
    const rows = store.prepare('SELECT repo FROM wiki_index_status').all();
    return rows.map((r) => String(r.repo));
  }

  /**
   * v2.6: true when the native vec_chunks query+upsert path is engaged for
   * this VectorStore instance. Read by tests + by Retriever metrics.
   */
  get hasSqliteVec(): boolean {
    return this._hasSqliteVec;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private fetchRowsForRepo(repo: string): Array<Record<string, unknown>> {
    const store = this.cache.getStore();
    return store
      .prepare(
        'SELECT repo, page_slug, section_slug, ordinal, text, github_repo, github_sha, github_path, github_line_range, embedding, indexed_at, commit_sha FROM chunks WHERE repo = ?',
      )
      .all(repo);
  }

  private encodeEmbedding(v: Float32Array): unknown {
    if (this.inMemory) return v;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  private decodeEmbedding(value: unknown): Float32Array {
    if (value instanceof Float32Array) return value;
    if (Buffer.isBuffer(value)) {
      // Slice off the byteOffset; produces a fresh Float32Array view.
      return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (value && typeof value === 'object' && (value as { type?: string }).type === 'Buffer' && Array.isArray((value as { data?: number[] }).data)) {
      // Some serialization round-trips produce {type:'Buffer', data:[...]}
      const buf = Buffer.from((value as { data: number[] }).data);
      return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    }
    throw new Error(`vector_store: cannot decode embedding value of type ${typeof value}`);
  }
}

/** Cosine similarity for two L2-normalized vectors == dot product. */
function cosineSim(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
