/**
 * Three logical caches over one SQLite store: pages, repos, wiki_status.
 *
 * The Cache class hides the storage layer (better-sqlite3 OR Map fallback)
 * behind typed methods so callers never see raw rows or SQL.
 */

import { CACHE_DB_PATH, FORCE_INMEMORY_CACHE } from '../config.js';
import { EMBED_MODEL_DIM } from '../config_rag.js';
import { openStore, SqliteStore, SqliteStatement } from '../adapters/sqlite_store.js';
import { getLogger } from '../logging.js';
import type { BomImport } from '../types.js';

/**
 * v2.5 (post-verify Codex high fix): cache value envelope for
 * maven_bom_versions + maven_parent_versions. Stores BOTH literal
 * `<dependencyManagement>` versions AND nested `<scope>import</scope>`
 * BOMs so the recursive walker (bom_resolver) and parent_resolver see
 * the same data on warm-cache hits as on cold fetches. Backward-compat:
 * pre-v2.5 rows with the old shape (`Record<string, string>`) are
 * treated as `{ versions: <oldMap>, nestedBoms: [] }`.
 */
interface PomDmEnvelope {
  versions: Record<string, string>;
  nestedBoms: BomImport[];
}

function parseEnvelope(raw: string): PomDmEnvelope {
  const parsed: unknown = JSON.parse(raw);
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if ('versions' in obj && 'nestedBoms' in obj) {
      const versions = obj.versions;
      const nestedBoms = obj.nestedBoms;
      if (versions && typeof versions === 'object' && Array.isArray(nestedBoms)) {
        return {
          versions: versions as Record<string, string>,
          nestedBoms: nestedBoms as BomImport[],
        };
      }
    }
    // Pre-v2.5 shape: flat Record<string, string>.
    return { versions: obj as Record<string, string>, nestedBoms: [] };
  }
  return { versions: {}, nestedBoms: [] };
}

function serializeEnvelope(versions: Record<string, string>, nestedBoms: BomImport[]): string {
  return JSON.stringify({ versions, nestedBoms });
}

/**
 * v2.6: decode a chunks.embedding BLOB column into a Float32Array.
 * Mirrors VectorStore.decodeEmbedding (kept local to avoid a circular
 * import; VectorStore.decodeEmbedding handles the same shapes for the
 * runtime query path). Used by the v6 migration backfill.
 */
function decodeEmbeddingBuffer(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (Buffer.isBuffer(value)) {
    return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (
    value &&
    typeof value === 'object' &&
    (value as { type?: string }).type === 'Buffer' &&
    Array.isArray((value as { data?: number[] }).data)
  ) {
    const buf = Buffer.from((value as { data: number[] }).data);
    return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  }
  throw new Error(`cache.decodeEmbeddingBuffer: cannot decode embedding value of type ${typeof value}`);
}

/**
 * v2.5: emit a `cache_hit` or `cache_miss` metric tagged with the table.
 * Called from each `get*` method to surface cache effectiveness.
 */
function emitCacheMetric(table: string, hit: boolean): void {
  getLogger().metric(hit ? 'cache_hit' : 'cache_miss', 1, { table });
}

export interface CachedPage {
  body: unknown;
  fetchedAt: number;
  commitSha: string;
}

export interface CachedRepo {
  owner: string;
  repo: string;
  source: string;
  confidence: string;
  resolvedAt: number;
}

export interface CachedWikiStatus {
  hasWiki: boolean;
  pageCount: number;
  pageIndex: unknown;
  checkedAt: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pages (repo TEXT, slug TEXT, body TEXT, fetched_at INTEGER, commit_sha TEXT, PRIMARY KEY (repo, slug));
CREATE TABLE IF NOT EXISTS repos (query TEXT, ecosystem TEXT, owner TEXT, repo TEXT, source TEXT, confidence TEXT, resolved_at INTEGER, PRIMARY KEY (query, ecosystem));
CREATE TABLE IF NOT EXISTS wiki_status (repo TEXT PRIMARY KEY, has_wiki INTEGER, page_count INTEGER, page_index TEXT, checked_at INTEGER);
CREATE TABLE IF NOT EXISTS chunks (repo TEXT, page_slug TEXT, section_slug TEXT, ordinal INTEGER, text TEXT, github_repo TEXT, github_sha TEXT, github_path TEXT, github_line_range TEXT, embedding BLOB, indexed_at INTEGER, commit_sha TEXT, PRIMARY KEY (repo, page_slug, section_slug, ordinal));
CREATE TABLE IF NOT EXISTS wiki_index_status (repo TEXT PRIMARY KEY, indexed_at INTEGER, commit_sha TEXT, chunk_count INTEGER, edge_count INTEGER);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS kg_edges (src_kind TEXT NOT NULL, src_id TEXT NOT NULL, dst_kind TEXT NOT NULL, dst_id TEXT NOT NULL, edge_type TEXT NOT NULL, repo TEXT NOT NULL, metadata TEXT, commit_sha TEXT, indexed_at INTEGER NOT NULL, PRIMARY KEY (src_kind, src_id, dst_kind, dst_id, edge_type, repo));
CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges (src_kind, src_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges (dst_kind, dst_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_kg_edges_repo ON kg_edges (repo);
CREATE TABLE IF NOT EXISTS maven_bom_versions (group_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version TEXT NOT NULL, version_map TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (group_id, artifact_id, version));
CREATE TABLE IF NOT EXISTS maven_parent_versions (group_id TEXT NOT NULL, artifact_id TEXT NOT NULL, version TEXT NOT NULL, version_map TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (group_id, artifact_id, version));
`;

/**
 * v2-shape DBs already have `wiki_index_status` from before `edge_count`
 * existed. The `CREATE TABLE IF NOT EXISTS` above is a no-op against an
 * existing table, so we run an explicit `ALTER TABLE ADD COLUMN` guarded
 * by try/catch — sqlite errors when re-adding an existing column, and the
 * in-memory store's tiny SQL parser ignores ALTER, both of which we accept
 * silently (the in-memory store always builds the v3 shape on a fresh
 * instance, so the ALTER is unnecessary there).
 */
const ALTER_WIKI_INDEX_STATUS_FOR_V3 = 'ALTER TABLE wiki_index_status ADD COLUMN edge_count INTEGER';

/**
 * Schema version. v1 used schema_version 1 (implicit, no `meta` table);
 * v2 explicitly writes `'2'` after running the additive migration.
 * v3 (v2.1 KG) adds `kg_edges` + 3 indexes AND adds an `edge_count` column
 * to `wiki_index_status` (additive, ALTER-guarded for v2 upgrades).
 * v4 (v2.4) adds `maven_bom_versions` (additive — `CREATE TABLE IF NOT EXISTS`
 * is idempotent on both directions, so v2.3 binaries opening a v4 DB are
 * unaffected; the only forward-only change is the `meta.schema_version` row).
 * v5 (v2.5) adds `maven_parent_versions` (same shape as `maven_bom_versions`,
 * additive). Also introduces the `embed_model` + `embed_model_dim` rows in
 * the existing `meta` table — no schema change, just new well-known keys
 * read by the startup hook for the auto-reindex contract.
 * v6 (v2.6) adds the `vec_chunks` virtual table (`USING vec0`) for native
 * cosine search via sqlite-vec. The migration backfills `vec_chunks` from
 * existing `chunks.embedding` rows in the same SQLite transaction —
 * without backfill, v2.5 users would see zero native results because
 * `wiki_index_status` short-circuits Indexer.indexRepo on freshness.
 * Stamping schema_version = 6 happens INSIDE the migration transaction,
 * so a partial migration (rollback) leaves schema at 5 and the pure-JS
 * fallback covers all queries.
 */
const SCHEMA_VERSION = 7;

/**
 * v2.8: KG extractor data-version, stamped in `meta.kg_extractor_version`
 * parallel to (not bumping) `schema_version`. On every Cache open the
 * constructor compares the stamped value to this constant; on mismatch
 * (including null on first v2.8 boot) it runs a single data-only fix:
 * `UPDATE wiki_index_status SET edge_count = -1`. The indexer's existing
 * `edge_count < 0` sentinel branch (src/services/indexer.ts:160) then
 * forces a full graph rebuild on the next `find_neighbors` call per
 * repo. No DDL, no schema_version touch — runs regardless of vec/fts
 * availability so SIP/sandboxed users still benefit.
 */
const KG_EXTRACTOR_VERSION = '2.8.0';

export interface CacheOpenOptions {
  dbPath?: string;
  forceInMemory?: boolean;
  /**
   * Test seam: when true, the v6 migration treats the store as if
   * sqlite-vec is unavailable, regardless of `store.vecAvailable`. The
   * migration becomes a no-op and schema stays at 5 (or whatever current
   * is). Used by tests to exercise the pure-JS fallback path.
   */
  testForceVecUnavailable?: boolean;
  /**
   * v2.7 test seam: when true, the v7 migration treats FTS5 as if
   * unavailable. The migration becomes a no-op and schema stays at 6
   * (or whatever current is). Used by tests to exercise the
   * vector-only fallback path.
   */
  testForceFtsUnavailable?: boolean;
}

export class Cache {
  private readonly store: SqliteStore;
  /**
   * v2.6: tracks whether the v6 migration succeeded for this Cache instance.
   * False when (a) the store is in-memory, (b) sqlite-vec failed to load on
   * the connection, (c) `testForceVecUnavailable` is set, OR (d) the v6
   * migration aborted (e.g., dim mismatch). VectorStore consults this to
   * decide between native and pure-JS query paths.
   */
  private readonly _vecAvailable: boolean;
  /**
   * v2.7: tracks whether the v7 migration succeeded for this Cache instance.
   * False when (a) the store is in-memory, (b) FTS5 probe failed at the
   * connection (exotic better-sqlite3 build), (c) `testForceFtsUnavailable`
   * is set, OR (d) the v7 migration aborted (per-row failure threshold
   * exceeded). VectorStore consults this to decide between hybrid and
   * vector-only retrieval paths.
   */
  private readonly _ftsAvailable: boolean;

  // Module-level prepared statement cache (per Cache instance).
  private readonly stmts: {
    pageGet: SqliteStatement;
    pageSet: SqliteStatement;
    pageDelete: SqliteStatement;
    pageRefresh: SqliteStatement;
    repoGet: SqliteStatement;
    repoSet: SqliteStatement;
    repoDelete: SqliteStatement;
    wikiGet: SqliteStatement;
    wikiSet: SqliteStatement;
    wikiDelete: SqliteStatement;
    metaGet: SqliteStatement;
    metaSet: SqliteStatement;
    bomGet: SqliteStatement;
    bomSet: SqliteStatement;
    parentGet: SqliteStatement;
    parentSet: SqliteStatement;
  };

  private constructor(store: SqliteStore, opts: CacheOpenOptions = {}) {
    this.store = store;
    const vecRequested = !store.isInMemory && store.vecAvailable && !opts.testForceVecUnavailable;

    // Split SCHEMA_SQL on `;` and exec each separately so the in-memory store
    // can match each `CREATE TABLE IF NOT EXISTS …` statement individually.
    for (const stmt of SCHEMA_SQL.split(';')) {
      const trimmed = stmt.trim();
      if (trimmed.length > 0) {
        this.store.exec(trimmed + ';');
      }
    }

    // v2 → v3: add edge_count column to existing wiki_index_status. Guarded
    // because (a) sqlite errors when re-adding an existing column on v3 DBs,
    // (b) the in-memory store's parser ignores ALTER (no-op there).
    try {
      this.store.exec(ALTER_WIKI_INDEX_STATUS_FOR_V3 + ';');
    } catch {
      /* column already exists or backend ignores ALTER — both acceptable */
    }

    this.stmts = {
      pageGet: this.store.prepare('SELECT body, fetched_at, commit_sha FROM pages WHERE repo = ? AND slug = ?'),
      pageSet: this.store.prepare('INSERT OR REPLACE INTO pages (repo, slug, body, fetched_at, commit_sha) VALUES (?, ?, ?, ?, ?)'),
      pageDelete: this.store.prepare('DELETE FROM pages WHERE repo = ? AND slug = ?'),
      pageRefresh: this.store.prepare('UPDATE pages SET fetched_at = ? WHERE repo = ? AND slug = ?'),
      repoGet: this.store.prepare('SELECT owner, repo, source, confidence, resolved_at FROM repos WHERE query = ? AND ecosystem = ?'),
      repoSet: this.store.prepare('INSERT OR REPLACE INTO repos (query, ecosystem, owner, repo, source, confidence, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      repoDelete: this.store.prepare('DELETE FROM repos WHERE query = ? AND ecosystem = ?'),
      wikiGet: this.store.prepare('SELECT has_wiki, page_count, page_index, checked_at FROM wiki_status WHERE repo = ?'),
      wikiSet: this.store.prepare('INSERT OR REPLACE INTO wiki_status (repo, has_wiki, page_count, page_index, checked_at) VALUES (?, ?, ?, ?, ?)'),
      wikiDelete: this.store.prepare('DELETE FROM wiki_status WHERE repo = ?'),
      metaGet: this.store.prepare('SELECT value FROM meta WHERE key = ?'),
      metaSet: this.store.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
      bomGet: this.store.prepare('SELECT version_map, fetched_at FROM maven_bom_versions WHERE group_id = ? AND artifact_id = ? AND version = ?'),
      bomSet: this.store.prepare('INSERT OR REPLACE INTO maven_bom_versions (group_id, artifact_id, version, version_map, fetched_at) VALUES (?, ?, ?, ?, ?)'),
      parentGet: this.store.prepare('SELECT version_map, fetched_at FROM maven_parent_versions WHERE group_id = ? AND artifact_id = ? AND version = ?'),
      parentSet: this.store.prepare('INSERT OR REPLACE INTO maven_parent_versions (group_id, artifact_id, version, version_map, fetched_at) VALUES (?, ?, ?, ?, ?)'),
    };

    // v5 → v6 migration: create vec_chunks virtual table + backfill from
    // existing chunks rows. Runs only when sqlite-vec is loaded on this
    // connection AND testForceVecUnavailable is not set. On failure
    // (dim mismatch, sqlite error, etc.), schema stays at <= 5 and the
    // pure-JS fallback engages. Stamping schema_version=6 happens INSIDE
    // the migration transaction so partial state is impossible.
    let v6Ok = false;
    if (vecRequested) {
      v6Ok = this.runV6Migration();
    }
    this._vecAvailable = vecRequested && v6Ok;

    // v2.7: probe FTS5 + run v6 → v7 migration. The v7 migration chains
    // on v6 success — schema_version is monotonic, so we don't stamp 7
    // unless 6 was also stamped (vec is available). When vec is absent,
    // FTS5 stays dormant for this Cache instance; a future open with vec
    // available will run both migrations cleanly.
    const ftsRequested = this._vecAvailable && !opts.testForceFtsUnavailable && this.probeFts5();
    let v7Ok = false;
    if (ftsRequested) {
      v7Ok = this.runV7Migration();
    }
    this._ftsAvailable = ftsRequested && v7Ok;

    // Stamp the highest schema version achieved. Order:
    //   v7 (FTS5 backfilled) > v6 (vec backfilled) > 5 (additive only).
    const current = this.stmts.metaGet.get('schema_version');
    const currentVer = current ? Number(current.value) : 0;
    const targetIfNoV6 = 5;
    if (this._ftsAvailable) {
      // v7 migration stamped already; no-op.
    } else if (this._vecAvailable) {
      // v6 migration stamped 6 already; no-op.
    } else if (currentVer < targetIfNoV6) {
      this.stmts.metaSet.run('schema_version', String(targetIfNoV6));
    }

    // v2.8: KG extractor data migration — see KG_EXTRACTOR_VERSION docstring.
    // Runs regardless of vec/fts availability because it's data-only (no DDL).
    // Wrap in try/catch so a sqlite IO error doesn't fail Cache construction —
    // degraded behavior (stuck on v2.7 edges) is acceptable; brick is not.
    try {
      const kgRow = this.stmts.metaGet.get('kg_extractor_version');
      const kgCurrent = kgRow ? String(kgRow.value) : null;
      if (kgCurrent !== KG_EXTRACTOR_VERSION) {
        const countRow = this.store
          .prepare('SELECT count(*) AS c FROM wiki_index_status')
          .get() as { c?: number } | undefined;
        const affectedRows = Number(countRow?.c ?? 0);
        if (affectedRows > 0) {
          this.store.exec('UPDATE wiki_index_status SET edge_count = -1');
        }
        this.stmts.metaSet.run('kg_extractor_version', KG_EXTRACTOR_VERSION);
        getLogger().info('cache.kg_extractor_version_bump', {
          from: kgCurrent,
          to: KG_EXTRACTOR_VERSION,
          affectedRows,
        });
      }
    } catch (err) {
      getLogger().error('cache.kg_extractor_version_migration_failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * v2.7: probe FTS5 availability by attempting to create + drop a
   * throwaway virtual table. Returns true when FTS5 is compiled into
   * this better-sqlite3 build, false otherwise. Safe to call on any
   * store; in-memory parsers ignore CREATE VIRTUAL TABLE (would not
   * even reach here — `ftsRequested` short-circuits on isInMemory).
   */
  private probeFts5(): boolean {
    try {
      this.store.exec('CREATE VIRTUAL TABLE IF NOT EXISTS __probe_fts USING fts5(t)');
      this.store.exec('DROP TABLE __probe_fts');
      return true;
    } catch (err) {
      getLogger().warn('cache.fts5_probe_failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * v2.7: runs the v6 → v7 migration in a single transaction.
   * Creates `fts_chunks` (contentless FTS5 virtual table) and backfills
   * from existing `chunks.text` rows with per-row error isolation.
   * Returns true on success; false on failure (rollback). Idempotent —
   * when current schema is already >= 7, returns true without changes.
   */
  private runV7Migration(): boolean {
    const log = getLogger();

    // Idempotent fast-path: already at v7.
    const currentRow = this.stmts.metaGet.get('schema_version');
    const current = currentRow ? Number(currentRow.value) : 0;
    if (current >= 7) {
      try {
        this.store.exec(
          "CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(text, tokenize='unicode61 remove_diacritics 2', content='', contentless_delete=1)",
        );
      } catch (err) {
        log.warn('cache.v7_migration.create_failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      return true;
    }

    let txStarted = false;
    try {
      this.store.exec('BEGIN');
      txStarted = true;
      this.store.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(text, tokenize='unicode61 remove_diacritics 2', content='', contentless_delete=1)",
      );

      const selectAll = this.store.prepare('SELECT rowid, text FROM chunks');
      const insertFts = this.store.prepare('INSERT INTO fts_chunks (rowid, text) VALUES (?, ?)');
      const rows = selectAll.all();
      let backfilled = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          const rowid = typeof row.rowid === 'bigint' ? row.rowid : BigInt(Number(row.rowid));
          const text = row.text == null ? '' : String(row.text);
          insertFts.run(rowid, text);
          backfilled++;
        } catch (err) {
          failed++;
          log.warn('cache.fts5_backfill_row_failed', {
            rowid: String(row.rowid),
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Threshold check: < 1% failed → stamp v7 with degraded coverage;
      // >= 1% failed → rollback + stay at v6.
      const total = rows.length;
      if (total > 0 && failed / total >= 0.01) {
        log.error('cache.fts5_backfill_threshold_exceeded', {
          failed,
          total,
          rate: failed / total,
        });
        this.store.exec('ROLLBACK');
        return false;
      }

      this.stmts.metaSet.run('schema_version', '7');
      this.store.exec('COMMIT');
      log.info('cache.v7_migration.complete', { backfilledRows: backfilled, failedRows: failed, total });
      return true;
    } catch (err) {
      if (txStarted) {
        try { this.store.exec('ROLLBACK'); } catch { /* best-effort */ }
      }
      log.error('cache.v7_migration.failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * v2.6: runs the v5 → v6 migration in a single transaction.
   * Returns true on success (vec_chunks created + backfilled, schema_version
   * stamped to 6); false on failure (dim mismatch, sqlite error). Idempotent
   * — when current schema is already >= 6, returns true without changes.
   */
  private runV6Migration(): boolean {
    const log = getLogger();
    const dim = EMBED_MODEL_DIM;

    // Idempotent fast-path: already at v6.
    const currentRow = this.stmts.metaGet.get('schema_version');
    const current = currentRow ? Number(currentRow.value) : 0;
    if (current >= 6) {
      // Make sure vec_chunks exists (defense-in-depth — a partial prior
      // migration could leave schema=6 but no table; create-if-not-exists
      // is idempotent).
      try {
        this.store.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}])`);
      } catch (err) {
        log.warn('cache.v6_migration.create_failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      return true;
    }

    let txStarted = false;
    try {
      this.store.exec('BEGIN');
      txStarted = true;
      this.store.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}])`);

      // Backfill from existing chunks. Iterate via SELECT all() — for v2.5-scale
      // indexes (~5k rows) this is fine; if a future scale demands streaming,
      // swap to a cursor.
      const selectAll = this.store.prepare('SELECT rowid, embedding FROM chunks');
      const insertVec = this.store.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)');
      const rows = selectAll.all();
      let backfilled = 0;
      for (const row of rows) {
        const blob = row.embedding;
        const vec = decodeEmbeddingBuffer(blob);
        if (vec.length !== dim) {
          throw new Error(
            `v6_migration_dim_mismatch: chunk rowid ${String(row.rowid)} has embedding length ${vec.length}, expected ${dim}`,
          );
        }
        const rowid = typeof row.rowid === 'bigint' ? row.rowid : BigInt(Number(row.rowid));
        insertVec.run(rowid, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
        backfilled++;
      }

      this.stmts.metaSet.run('schema_version', '6');
      this.stmts.metaSet.run('embed_model_dim', String(dim));
      this.store.exec('COMMIT');
      log.info('cache.v6_migration.complete', { backfilledRows: backfilled, dim });
      return true;
    } catch (err) {
      if (txStarted) {
        try { this.store.exec('ROLLBACK'); } catch { /* best-effort */ }
      }
      log.error('cache.v6_migration.failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** The persisted schema version (defaults to SCHEMA_VERSION on a fresh DB). */
  getSchemaVersion(): number {
    const row = this.stmts.metaGet.get('schema_version');
    return row ? Number(row.value) : SCHEMA_VERSION;
  }

  /** Internal: stamp the schema_version row. Public only for tests. */
  setSchemaVersion(version: number): void {
    this.stmts.metaSet.run('schema_version', String(version));
  }

  /** Direct SqliteStore access for VectorStore (and only VectorStore). */
  getStore(): SqliteStore {
    return this.store;
  }

  static async open(opts: CacheOpenOptions = {}): Promise<Cache> {
    const store = await openStore({
      dbPath: opts.dbPath ?? CACHE_DB_PATH,
      forceInMemory: opts.forceInMemory ?? FORCE_INMEMORY_CACHE,
    });
    return new Cache(store, opts);
  }

  get isInMemory(): boolean {
    return this.store.isInMemory;
  }

  /**
   * v2.6: true when sqlite-vec is loaded AND the v6 migration succeeded
   * for this Cache instance. VectorStore reads this to choose between
   * native vec_distance_cosine and pure-JS cosine paths.
   */
  get vecAvailable(): boolean {
    return this._vecAvailable;
  }

  /**
   * v2.7: true when FTS5 is available AND the v7 migration succeeded
   * for this Cache instance. VectorStore reads this to choose between
   * hybrid (BM25 + vector) and vector-only retrieval paths.
   */
  get ftsAvailable(): boolean {
    return this._ftsAvailable;
  }

  // -------------------------------------------------------------------------
  // pages
  // -------------------------------------------------------------------------

  getPage(repo: string, slug: string): CachedPage | null {
    const row = this.stmts.pageGet.get(repo, slug);
    if (!row) return null;
    return {
      body: JSON.parse(String(row.body)),
      fetchedAt: Number(row.fetched_at),
      commitSha: String(row.commit_sha),
    };
  }

  setPage(repo: string, slug: string, body: unknown, commitSha: string): void {
    this.stmts.pageSet.run(repo, slug, JSON.stringify(body), Date.now(), commitSha);
  }

  invalidatePage(repo: string, slug: string): void {
    this.stmts.pageDelete.run(repo, slug);
  }

  refreshPageTimestamp(repo: string, slug: string): void {
    this.stmts.pageRefresh.run(Date.now(), repo, slug);
  }

  // -------------------------------------------------------------------------
  // repos
  // -------------------------------------------------------------------------

  getRepo(query: string, ecosystem: string): CachedRepo | null {
    const row = this.stmts.repoGet.get(query, ecosystem);
    emitCacheMetric('repos', row !== null && row !== undefined);
    if (!row) return null;
    return {
      owner: String(row.owner),
      repo: String(row.repo),
      source: String(row.source),
      confidence: String(row.confidence),
      resolvedAt: Number(row.resolved_at),
    };
  }

  setRepo(query: string, ecosystem: string, owner: string, repo: string, source: string, confidence: string): void {
    this.stmts.repoSet.run(query, ecosystem, owner, repo, source, confidence, Date.now());
  }

  /**
   * v2.2: invalidate the repo-resolution cache for a given (query, ecosystem).
   * Used by `manifest_watcher` when a dep is removed from the project's manifest.
   */
  invalidateRepo(query: string, ecosystem: string): void {
    this.stmts.repoDelete.run(query, ecosystem);
  }

  // -------------------------------------------------------------------------
  // wiki_status
  // -------------------------------------------------------------------------

  getWikiStatus(repo: string): CachedWikiStatus | null {
    const row = this.stmts.wikiGet.get(repo);
    emitCacheMetric('wiki_status', row !== null && row !== undefined);
    if (!row) return null;
    return {
      hasWiki: Number(row.has_wiki) === 1,
      pageCount: Number(row.page_count),
      pageIndex: JSON.parse(String(row.page_index)),
      checkedAt: Number(row.checked_at),
    };
  }

  setWikiStatus(repo: string, hasWiki: boolean, pageCount: number, pageIndex: unknown): void {
    this.stmts.wikiSet.run(repo, hasWiki ? 1 : 0, pageCount, JSON.stringify(pageIndex), Date.now());
  }

  /**
   * v2.2: invalidate the wiki_status cache for a given repo. Used by
   * `manifest_watcher` after a dep is removed AND no surviving dep resolves to
   * the same `<owner>/<repo>`.
   */
  invalidateWikiStatus(repo: string): void {
    this.stmts.wikiDelete.run(repo);
  }

  // -------------------------------------------------------------------------
  // maven_bom_versions (v2.4)
  // -------------------------------------------------------------------------

  /**
   * Read a previously-fetched BOM POM's `<dependencyManagement>` version map.
   * Returns `null` on miss. The `bom_resolver` service is the only caller.
   */
  getMavenBomVersions(
    groupId: string,
    artifactId: string,
    version: string,
  ): { versionMap: Record<string, string>; nestedBoms: BomImport[]; fetchedAt: number } | null {
    const row = this.stmts.bomGet.get(groupId, artifactId, version);
    emitCacheMetric('maven_bom_versions', row !== null && row !== undefined);
    if (!row) return null;
    const env = parseEnvelope(String(row.version_map));
    return {
      versionMap: env.versions,
      nestedBoms: env.nestedBoms,
      fetchedAt: Number(row.fetched_at),
    };
  }

  /**
   * Store a BOM POM's parsed version map AND its nested `<scope>import</scope>`
   * BOMs. Persisted across server restarts. v2.5 post-verify Codex high fix:
   * nestedBoms are now persisted so warm-cache hits don't drop the recursive
   * walk's depth-N+1 frontier.
   */
  setMavenBomVersions(
    groupId: string,
    artifactId: string,
    version: string,
    versionMap: Record<string, string>,
    nestedBoms: BomImport[] = [],
  ): void {
    this.stmts.bomSet.run(
      groupId,
      artifactId,
      version,
      serializeEnvelope(versionMap, nestedBoms),
      Date.now(),
    );
  }

  // -------------------------------------------------------------------------
  // maven_parent_versions (v2.5)
  // -------------------------------------------------------------------------

  /**
   * Read a previously-fetched parent POM's `<dependencyManagement>` literal
   * version map. Returns `null` on miss. The `parent_resolver` service is
   * the only caller. (Parent's nested BOM imports are NOT cached here —
   * they flow through `bom_resolver`'s own cache via `scan.bomImports`.)
   */
  getMavenParentVersions(
    groupId: string,
    artifactId: string,
    version: string,
  ): { versionMap: Record<string, string>; nestedBoms: BomImport[]; fetchedAt: number } | null {
    const row = this.stmts.parentGet.get(groupId, artifactId, version);
    emitCacheMetric('maven_parent_versions', row !== null && row !== undefined);
    if (!row) return null;
    const env = parseEnvelope(String(row.version_map));
    return {
      versionMap: env.versions,
      nestedBoms: env.nestedBoms,
      fetchedAt: Number(row.fetched_at),
    };
  }

  /**
   * Store a parent POM's parsed literal version map AND its nested
   * `<scope>import</scope>` BOMs. v2.5 post-verify Codex high fix:
   * persisting nested BOMs restores the Spring Boot Starter Parent
   * canonical pattern on warm-cache hits — without this, parent's nested
   * BOM imports were dropped after the first cold call.
   */
  setMavenParentVersions(
    groupId: string,
    artifactId: string,
    version: string,
    versionMap: Record<string, string>,
    nestedBoms: BomImport[] = [],
  ): void {
    this.stmts.parentSet.run(
      groupId,
      artifactId,
      version,
      serializeEnvelope(versionMap, nestedBoms),
      Date.now(),
    );
  }

  // -------------------------------------------------------------------------
  // embedder fingerprint (v2.5)
  // -------------------------------------------------------------------------

  /**
   * v2.5: read the persisted embedder fingerprint (model + dim). Returns
   * null when the rows are absent — the startup hook then inspects
   * `VectorStore.hasAnyIndex()` to decide between fresh-install (no-op)
   * and legacy v2.4-DB synthesis (use `LEGACY_EMBED_MODEL_DEFAULT`).
   */
  getEmbedderFingerprint(): { model: string; dim: number } | null {
    const modelRow = this.stmts.metaGet.get('embed_model');
    const dimRow = this.stmts.metaGet.get('embed_model_dim');
    if (!modelRow || !dimRow) return null;
    const model = String(modelRow.value);
    const dim = Number(dimRow.value);
    if (!model || !Number.isFinite(dim)) return null;
    return { model, dim };
  }

  /** v2.5: stamp the embedder fingerprint after a successful index build. */
  setEmbedderFingerprint(model: string, dim: number): void {
    this.stmts.metaSet.run('embed_model', model);
    this.stmts.metaSet.run('embed_model_dim', String(dim));
  }

  /**
   * v2.6: read the persisted reranker model fingerprint. Returns null when
   * the row is absent (no successful rerank yet OR fresh install). Audit-
   * only — does NOT influence chunk-drop or index validity.
   */
  getRerankModel(): string | null {
    const row = this.stmts.metaGet.get('rerank_model');
    if (!row) return null;
    const v = String(row.value);
    return v.length > 0 ? v : null;
  }

  /** v2.6: stamp the reranker model after the first successful score call. */
  setRerankModel(model: string): void {
    this.stmts.metaSet.run('rerank_model', model);
  }

  /**
   * v2.6: read the persisted embed_model_dim row alone (independent of the
   * model id). Used by the dim-swap detection in runEmbedderAutoReindex.
   * Returns null when absent (legacy v2.4 DB without the row).
   */
  getEmbedModelDim(): number | null {
    const row = this.stmts.metaGet.get('embed_model_dim');
    if (!row) return null;
    const n = Number(row.value);
    return Number.isFinite(n) ? n : null;
  }

  /** v2.6: stamp the embed_model_dim row alone. */
  setEmbedModelDim(dim: number): void {
    this.stmts.metaSet.run('embed_model_dim', String(dim));
  }

  close(): void {
    this.store.close();
  }
}
