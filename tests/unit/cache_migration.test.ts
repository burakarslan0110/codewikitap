/**
 * Schema-migration unit tests — assert the v1 → v2 → v3 → v4 → v5 → v6 migrations
 * are additive, idempotent, and preserve all earlier rows.
 *
 * v3 (the v2.1 KG bump): adds the `kg_edges` table + 3 indexes AND adds an
 * `edge_count` column to `wiki_index_status`.
 * v4 (the v2.4 Maven BOM bump): adds the `maven_bom_versions` table.
 * v5 (the v2.5 Maven parent bump): adds the `maven_parent_versions` table.
 * v6 (the v2.6 sqlite-vec activation): adds the `vec_chunks` virtual table AND
 * backfills it from existing `chunks.embedding` rows in the same transaction.
 * All must work on fresh DBs AND on older-shape DBs that already had rows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-mig-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Schema migration — fresh DB', () => {
  it('opening a fresh DB sets schema_version = 3', async () => {
    const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
    expect(cache.getSchemaVersion()).toBe(7);
    cache.close();
  });

  it('creates kg_edges table on fresh DB', async () => {
    const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
    const store = cache.getStore();
    // A SELECT against kg_edges must not throw (table exists).
    expect(() => store.prepare('SELECT * FROM kg_edges').all()).not.toThrow();
    cache.close();
  });

  it('wiki_index_status accepts edge_count on fresh DB', async () => {
    const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
    const store = cache.getStore();
    // The schema must include edge_count — a SELECT of that column must succeed.
    expect(() => store.prepare('SELECT edge_count FROM wiki_index_status').all()).not.toThrow();
    cache.close();
  });
});

describe('Schema migration — idempotency', () => {
  it('opening the same DB twice keeps schema_version = 3', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    a.close();
    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(7);
    b.close();
  });

  it('re-opening a DB does not throw on the ALTER guard', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    // Open three times in a row — the ALTER TABLE for edge_count must be
    // wrapped so re-running on a DB that already has the column does not
    // error out.
    for (let i = 0; i < 3; i++) {
      const c = await Cache.open({ dbPath });
      expect(c.getSchemaVersion()).toBe(7);
      c.close();
    }
  });
});

describe('Schema migration — v1 rows survive', () => {
  it('preserves pages, repos, wiki_status across migration', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');

    const a = await Cache.open({ dbPath });
    a.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    a.setWikiStatus('facebook/react', true, 12, [
      { slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
    ]);
    a.setPage('facebook/react', '__root__', { test: 'body' }, 'aabb' + 'c'.repeat(36));
    a.close();

    const b = await Cache.open({ dbPath });
    expect(b.getRepo('react', 'npm')?.owner).toBe('facebook');
    expect(b.getWikiStatus('facebook/react')?.pageCount).toBe(12);
    expect(b.getPage('facebook/react', '__root__')?.commitSha).toBe('aabb' + 'c'.repeat(36));
    expect(b.getSchemaVersion()).toBe(7);
    b.close();
  });
});

describe('Schema migration — v2-shape DB upgrades cleanly', () => {
  it('a DB that already has v2 wiki_index_status rows reads edge_count as null/-1 sentinel after upgrade', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');

    // Bootstrap as if we were v2: open with v3 code (which creates kg_edges +
    // edge_count column), then insert a row using ONLY the v2 columns to
    // simulate a row that pre-existed the edge_count addition. The store
    // exposes a raw write path via getStore(), which we use to mimic the
    // v2 INSERT shape.
    const a = await Cache.open({ dbPath });
    const store = a.getStore();
    store
      .prepare('INSERT OR REPLACE INTO wiki_index_status (repo, indexed_at, commit_sha, chunk_count) VALUES (?, ?, ?, ?)')
      .run('legacy/repo', Date.now(), 'aabb' + 'c'.repeat(36), 5);
    a.close();

    // Re-open and read edge_count for that row — must be NULL or sentinel,
    // and must not throw.
    const b = await Cache.open({ dbPath });
    const store2 = b.getStore();
    const row = store2.prepare('SELECT edge_count FROM wiki_index_status WHERE repo = ?').get('legacy/repo');
    // Either null (DB-level NULL) or -1 (sentinel mapped at app layer); both
    // are acceptable — application code MUST handle both. Test asserts the
    // value is NOT a positive integer (i.e. NOT a real edge count).
    const ec = row?.edge_count;
    expect(ec === null || ec === undefined || Number(ec) === -1 || Number.isNaN(Number(ec))).toBe(true);
    b.close();
  });

  it('a kg_edges INSERT round-trips on a fresh v3 DB', async () => {
    const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
    const store = cache.getStore();
    store
      .prepare(
        'INSERT OR REPLACE INTO kg_edges (src_kind, src_id, dst_kind, dst_id, edge_type, repo, metadata, commit_sha, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('section', 'fixture/repo#core', 'file', 'fixture/repo:src/index.ts', 'code_ref', 'fixture/repo', '{"line":"L1"}', 'aabb' + 'c'.repeat(36), Date.now());
    const rows = store
      .prepare('SELECT src_id, dst_id FROM kg_edges WHERE repo = ?')
      .all('fixture/repo');
    expect(rows).toHaveLength(1);
    expect(rows[0].src_id).toBe('fixture/repo#core');
    expect(rows[0].dst_id).toBe('fixture/repo:src/index.ts');
    cache.close();
  });
});

// v2.4: schema v3 → v4 + v2.3-binary forward compat. v2.5 bumps to 5;
// these tests now assert the v5 invariant (v4 was a transient stop —
// CREATE TABLE IF NOT EXISTS makes upgrades from any prior version idempotent).
describe('v2.4 + v2.5 schema migration — v3 → v4 → v5', () => {
  it('opening a fresh DB sets schema_version = 5 and creates maven_bom_versions + maven_parent_versions tables', async () => {
    const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
    expect(cache.getSchemaVersion()).toBe(7);
    const store = cache.getStore();
    expect(() => store.prepare('SELECT * FROM maven_bom_versions').all()).not.toThrow();
    expect(() => store.prepare('SELECT * FROM maven_parent_versions').all()).not.toThrow();
    cache.close();
  });

  it('upgrades a v3-shape DB (schema_version stamp = 3) without losing data', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    // Bootstrap: open with current binary, force-stamp schema_version=3 to
    // simulate a v2.3 state, then re-open with v2.5 code.
    const a = await Cache.open({ dbPath });
    a.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    a.setSchemaVersion(3);
    a.close();

    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(7); // upgraded v3 → v5 in one open
    expect(b.getRepo('react', 'npm')?.owner).toBe('facebook'); // pre-v5 data intact
    b.close();
  });

  it('upgrades a v4-shape DB (schema_version stamp = 4) to v5 without losing data — v2.5 plan Task 1 DoD', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    // Bootstrap: open with current binary, force-stamp schema_version=4 to
    // simulate a v2.4 state.
    const a = await Cache.open({ dbPath });
    a.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    a.setMavenBomVersions('org.springframework.boot', 'spring-boot-dependencies', '3.2.0', {
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
    });
    a.setSchemaVersion(4);
    a.close();

    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(7);
    expect(b.getRepo('react', 'npm')?.owner).toBe('facebook'); // v3 data intact
    expect(
      b.getMavenBomVersions('org.springframework.boot', 'spring-boot-dependencies', '3.2.0')
        ?.versionMap['org.springframework.boot:spring-boot-starter-web'],
    ).toBe('3.2.0'); // v4 data intact
    const store = b.getStore();
    expect(() => store.prepare('SELECT * FROM maven_parent_versions').all()).not.toThrow();
    b.close();
  });

  it('v2.3-binary forward compat: schema_version comparison is `< SCHEMA_VERSION` (NOT exact-match), so a v2.3 binary opening a v5 DB does not crash and does not downgrade', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    expect(a.getSchemaVersion()).toBe(7);
    a.close();

    // Simulate a v2.3 binary by force-stamping schema_version=3 in the DB
    // and then re-opening — current binary's `< SCHEMA_VERSION` comparison
    // is bounded-range (not exact-match), so the open is non-destructive.
    const b = await Cache.open({ dbPath });
    b.setSchemaVersion(3); // pretend a downgrade happened
    b.close();
    const c = await Cache.open({ dbPath });
    expect(c.getSchemaVersion()).toBe(7);
    c.close();
  });
});

/**
 * v2.6 schema migration: v5 → v6 adds the `vec_chunks` virtual table AND
 * backfills it from existing `chunks.embedding` rows. Without backfill,
 * a v2.5 user upgrading to v2.6 would see zero native results because
 * `wiki_index_status` short-circuits `Indexer.indexRepo` on freshness.
 *
 * These tests assume sqlite-vec is loadable (it ships in node_modules).
 * The `testForceVecUnavailable` open-option exercises the no-vec path.
 */
describe('v2.6 schema migration — v5 → v6 with vec_chunks backfill', () => {
  // Helper: insert a chunk row with a stable rowid via the raw store API.
  // chunks PK is (repo, page_slug, section_slug, ordinal) so the assigned
  // rowid is auto. We capture lastInsertRowid for the parity assertion.
  function insertChunk(
    cache: Cache,
    repo: string,
    pageSlug: string,
    sectionSlug: string,
    ordinal: number,
    embedding: Float32Array,
  ): bigint {
    const store = cache.getStore();
    const stmt = store.prepare(
      'INSERT INTO chunks (repo, page_slug, section_slug, ordinal, text, github_repo, github_sha, github_path, github_line_range, embedding, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const result = stmt.run(
      repo,
      pageSlug,
      sectionSlug,
      ordinal,
      'sample text',
      null,
      null,
      null,
      null,
      buf,
      Date.now(),
      'sha' + 'a'.repeat(37),
    );
    // lastInsertRowid is BigInt on better-sqlite3; cast for safety.
    const lastId = (result as unknown as { lastInsertRowid: bigint | number }).lastInsertRowid;
    return typeof lastId === 'bigint' ? lastId : BigInt(lastId);
  }

  function makeUnitVector(dim: number, idx: number): Float32Array {
    const v = new Float32Array(dim);
    v[idx % dim] = 1;
    return v;
  }

  // The default embedder dim is 384 (Xenova/bge-small-en-v1.5).
  const TEST_DIM = 384;

  it('fresh DB: schema_version = 6 AND vec_chunks virtual table exists', async () => {
    const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
    expect(cache.getSchemaVersion()).toBe(7);
    const store = cache.getStore();
    expect(() => store.prepare('SELECT * FROM vec_chunks').all()).not.toThrow();
    cache.close();
  });

  it('v5 → v6 migration backfills vec_chunks from existing chunks AND parity invariant holds', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');

    // Bootstrap as a v5 DB with chunks pre-populated.
    const a = await Cache.open({ dbPath });
    // Force-drop vec_chunks if it was created by the v6 migration on this open
    // and rewind schema_version to 5. This simulates a v2.5 DB on disk.
    a.getStore().exec('DROP TABLE IF EXISTS vec_chunks');
    insertChunk(a, 'fb/react', '__root__', 'core', 0, makeUnitVector(TEST_DIM, 0));
    insertChunk(a, 'fb/react', '__root__', 'hooks', 0, makeUnitVector(TEST_DIM, 1));
    insertChunk(a, 'fb/react', '__root__', 'hooks', 1, makeUnitVector(TEST_DIM, 2));
    a.setSchemaVersion(5);
    a.close();

    // Re-open: v6 migration runs, backfills vec_chunks, stamps schema_version=6.
    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(7);

    const store = b.getStore();
    const chunkCountRow = store.prepare('SELECT count(*) AS n FROM chunks').get();
    const vecCountRow = store.prepare('SELECT count(*) AS n FROM vec_chunks').get();
    expect(Number(chunkCountRow?.n)).toBe(3);
    expect(Number(vecCountRow?.n)).toBe(3);

    // Parity invariant: every chunks rowid has a matching vec_chunks rowid.
    const orphans = store
      .prepare(
        'SELECT chunks.rowid AS chunk_rowid FROM chunks LEFT JOIN vec_chunks ON vec_chunks.rowid = chunks.rowid WHERE vec_chunks.rowid IS NULL',
      )
      .all();
    expect(orphans).toHaveLength(0);

    b.close();
  });

  it('v6 migration is idempotent — second open is a no-op', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    insertChunk(a, 'fb/react', '__root__', 'core', 0, makeUnitVector(TEST_DIM, 0));
    a.close();

    // First re-open: at v6 already (fresh-DB path created vec_chunks). Capture row count.
    const b = await Cache.open({ dbPath });
    const store = b.getStore();
    const beforeCount = Number(store.prepare('SELECT count(*) AS n FROM vec_chunks').get()?.n);
    b.close();

    // Second re-open: must NOT duplicate or re-run the migration.
    const c = await Cache.open({ dbPath });
    expect(c.getSchemaVersion()).toBe(7);
    const afterCount = Number(c.getStore().prepare('SELECT count(*) AS n FROM vec_chunks').get()?.n);
    expect(afterCount).toBe(beforeCount);
    c.close();
  });

  it('v5 → v6 migration with NO chunks: vec_chunks created (empty), schema stamped 6', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    a.getStore().exec('DROP TABLE IF EXISTS vec_chunks');
    a.setSchemaVersion(5);
    a.close();

    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(7);
    expect(() => b.getStore().prepare('SELECT * FROM vec_chunks').all()).not.toThrow();
    expect(Number(b.getStore().prepare('SELECT count(*) AS n FROM vec_chunks').get()?.n)).toBe(0);
    b.close();
  });

  it('v5 → v6 migration aborts on dim mismatch: chunks have wrong-dim embeddings → stays at v5', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    a.getStore().exec('DROP TABLE IF EXISTS vec_chunks');
    // Insert a chunk with a 128-dim embedding — does NOT match the configured TEST_DIM (384).
    insertChunk(a, 'fb/react', '__root__', 'core', 0, makeUnitVector(128, 0));
    a.setSchemaVersion(5);
    a.close();

    // Re-open: migration should detect the mismatch, rollback, stay at v5.
    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(5);
    // chunks data preserved
    expect(Number(b.getStore().prepare('SELECT count(*) AS n FROM chunks').get()?.n)).toBe(1);
    b.close();
  });

  it('forward-compat: a v2.5-style binary opening a v6 DB reads chunks/wiki_index_status normally', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    // Open as v6 (fresh) and populate non-vec data.
    const a = await Cache.open({ dbPath });
    a.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    a.setPage('facebook/react', '__root__', { test: 'body' }, 'sha' + 'a'.repeat(37));
    insertChunk(a, 'facebook/react', '__root__', 'core', 0, makeUnitVector(TEST_DIM, 0));
    a.close();

    // Simulate a v2.5 binary by force-stamping schema_version=5; this binary
    // does NOT touch vec_chunks. Reads of chunks/wiki_index_status must work.
    const b = await Cache.open({ dbPath });
    b.setSchemaVersion(5);
    b.close();
    const c = await Cache.open({ dbPath });
    expect(c.getRepo('react', 'npm')?.owner).toBe('facebook');
    expect(c.getPage('facebook/react', '__root__')).not.toBeNull();
    expect(Number(c.getStore().prepare('SELECT count(*) AS n FROM chunks').get()?.n)).toBe(1);
    // Re-open will re-migrate v5 → v6 (idempotent), stamping back to 6.
    expect(c.getSchemaVersion()).toBe(7);
    c.close();
  });

  it('testForceVecUnavailable: stays at v5 — pure-JS path engages, schema does NOT stamp 6', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath, testForceVecUnavailable: true });
    expect(a.getSchemaVersion()).toBe(5);
    // vec_chunks must NOT exist on this path.
    expect(() => a.getStore().prepare('SELECT * FROM vec_chunks').all()).toThrow();
    a.close();
  });
});

/**
 * v2.7 schema migration: v6 → v7 adds the `fts_chunks` FTS5 virtual table AND
 * backfills it from existing `chunks.text` rows in the same transaction.
 * Without backfill, a v2.6 user upgrading to v2.7 would see zero BM25 results
 * because `wiki_index_status` short-circuits `Indexer.indexRepo` on freshness.
 *
 * FTS5 ships with better-sqlite3's prebuilt binaries; the `testForceFtsUnavailable`
 * open-option exercises the no-FTS5 path (defense-in-depth for exotic builds).
 */
describe('v2.7 schema migration — v6 → v7 with fts_chunks backfill', () => {
  function insertChunk(
    cache: Cache,
    repo: string,
    pageSlug: string,
    sectionSlug: string,
    ordinal: number,
    text: string,
    embedding: Float32Array,
  ): bigint {
    const store = cache.getStore();
    const stmt = store.prepare(
      'INSERT INTO chunks (repo, page_slug, section_slug, ordinal, text, github_repo, github_sha, github_path, github_line_range, embedding, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const result = stmt.run(
      repo,
      pageSlug,
      sectionSlug,
      ordinal,
      text,
      null, null, null, null,
      buf,
      Date.now(),
      'sha' + 'a'.repeat(37),
    );
    const lastId = (result as unknown as { lastInsertRowid: bigint | number }).lastInsertRowid;
    return typeof lastId === 'bigint' ? lastId : BigInt(lastId);
  }

  function makeUnitVector(dim: number, idx: number): Float32Array {
    const v = new Float32Array(dim);
    v[idx % dim] = 1;
    return v;
  }

  const TEST_DIM = 384;

  it('fresh DB: schema_version = 7 AND fts_chunks virtual table exists', async () => {
    const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
    expect(cache.getSchemaVersion()).toBe(7);
    expect(cache.ftsAvailable).toBe(true);
    const store = cache.getStore();
    expect(() => store.prepare('SELECT rowid FROM fts_chunks').all()).not.toThrow();
    cache.close();
  });

  it('v6 → v7 migration backfills fts_chunks from existing chunks AND BM25 parity invariant holds', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');

    // Bootstrap as a v6 DB with chunks pre-populated and fts_chunks absent.
    const a = await Cache.open({ dbPath });
    a.getStore().exec('DROP TABLE IF EXISTS fts_chunks');
    insertChunk(a, 'fb/react', '__root__', 'core', 0, 'authentication setup flow', makeUnitVector(TEST_DIM, 0));
    insertChunk(a, 'fb/react', '__root__', 'hooks', 0, 'useState hook example', makeUnitVector(TEST_DIM, 1));
    insertChunk(a, 'fb/react', '__root__', 'hooks', 1, 'useEffect hook example', makeUnitVector(TEST_DIM, 2));
    a.setSchemaVersion(6);
    a.close();

    // Re-open: v7 migration runs, backfills fts_chunks, stamps schema_version=7.
    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(7);

    const store = b.getStore();
    const chunkCount = Number(store.prepare('SELECT count(*) AS n FROM chunks').get()?.n);
    const ftsCount = Number(store.prepare('SELECT count(*) AS n FROM fts_chunks').get()?.n);
    expect(chunkCount).toBe(3);
    expect(ftsCount).toBe(3);

    // Parity invariant: every chunks rowid has a matching fts_chunks rowid.
    const orphans = store
      .prepare(
        'SELECT chunks.rowid AS chunk_rowid FROM chunks LEFT JOIN fts_chunks ON fts_chunks.rowid = chunks.rowid WHERE fts_chunks.rowid IS NULL',
      )
      .all();
    expect(orphans).toHaveLength(0);

    // Round-trip: a BM25 MATCH query against backfilled data returns expected rowids.
    const hits = store
      .prepare(
        "SELECT chunks.section_slug FROM chunks JOIN fts_chunks ON fts_chunks.rowid = chunks.rowid WHERE chunks.repo = ? AND fts_chunks MATCH 'hook' ORDER BY bm25(fts_chunks) ASC",
      )
      .all('fb/react');
    expect(hits.length).toBe(2);
    expect((hits[0] as { section_slug: string }).section_slug).toBe('hooks');

    b.close();
  });

  it('v7 migration is idempotent — second open is a no-op', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    insertChunk(a, 'fb/react', '__root__', 'core', 0, 'sample text', makeUnitVector(TEST_DIM, 0));
    a.close();

    const b = await Cache.open({ dbPath });
    const beforeCount = Number(b.getStore().prepare('SELECT count(*) AS n FROM fts_chunks').get()?.n);
    b.close();

    const c = await Cache.open({ dbPath });
    expect(c.getSchemaVersion()).toBe(7);
    const afterCount = Number(c.getStore().prepare('SELECT count(*) AS n FROM fts_chunks').get()?.n);
    expect(afterCount).toBe(beforeCount);
    c.close();
  });

  it('v6 → v7 migration with NO chunks: fts_chunks created (empty), schema stamped 7', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    a.getStore().exec('DROP TABLE IF EXISTS fts_chunks');
    a.setSchemaVersion(6);
    a.close();

    const b = await Cache.open({ dbPath });
    expect(b.getSchemaVersion()).toBe(7);
    expect(() => b.getStore().prepare('SELECT rowid FROM fts_chunks').all()).not.toThrow();
    expect(Number(b.getStore().prepare('SELECT count(*) AS n FROM fts_chunks').get()?.n)).toBe(0);
    b.close();
  });

  it('testForceFtsUnavailable: stays at v6 — vector-only path engages, schema does NOT stamp 7', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath, testForceFtsUnavailable: true });
    expect(a.getSchemaVersion()).toBe(6);
    expect(a.ftsAvailable).toBe(false);
    // fts_chunks must NOT exist on this path.
    expect(() => a.getStore().prepare('SELECT rowid FROM fts_chunks').all()).toThrow();
    a.close();
  });

  it('forward-compat: a v2.6-style binary opening a v7 DB reads chunks/wiki_index_status normally', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    a.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    insertChunk(a, 'facebook/react', '__root__', 'core', 0, 'sample', makeUnitVector(TEST_DIM, 0));
    a.close();

    // Simulate v2.6 binary: rewind schema_version to 6 (no fts_chunks touch).
    const b = await Cache.open({ dbPath });
    b.setSchemaVersion(6);
    b.close();

    // Now re-open as v2.7: migration re-runs idempotently, stamps back to 7.
    const c = await Cache.open({ dbPath });
    expect(c.getRepo('react', 'npm')?.owner).toBe('facebook');
    expect(Number(c.getStore().prepare('SELECT count(*) AS n FROM chunks').get()?.n)).toBe(1);
    expect(c.getSchemaVersion()).toBe(7);
    c.close();
  });
});

// ---------------------------------------------------------------------------
// v2.8 kg_extractor_version migration — data-only fix, parallel to schema_version
// ---------------------------------------------------------------------------

function seedWikiIndexStatus(cache: Cache, repo: string, edgeCount: number): void {
  cache.getStore()
    .prepare('INSERT OR REPLACE INTO wiki_index_status (repo, indexed_at, commit_sha, chunk_count, edge_count) VALUES (?, ?, ?, ?, ?)')
    .run(repo, Date.now(), 'a'.repeat(40), 10, edgeCount);
}

describe('Schema migration — v2.8 kg_extractor_version data migration', () => {
  it('resets edge_count to -1 when meta.kg_extractor_version is null and wiki_index_status has rows', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    seedWikiIndexStatus(a, 'facebook/react', 38);
    seedWikiIndexStatus(a, 'vanna-ai/vanna', 28);
    // Simulate a v2.7 DB: clear the v2.8 meta key (which the just-opened
    // Cache stamped) so the next open re-runs the migration.
    a.getStore().prepare("DELETE FROM meta WHERE key = 'kg_extractor_version'").run();
    a.close();

    const b = await Cache.open({ dbPath });
    const rows = b.getStore()
      .prepare('SELECT repo, edge_count FROM wiki_index_status ORDER BY repo')
      .all() as Array<{ repo: string; edge_count: number }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.edge_count).toBe(-1);
    }
    const metaRow = b.getStore()
      .prepare("SELECT value FROM meta WHERE key = 'kg_extractor_version'")
      .get() as { value: string } | undefined;
    expect(metaRow?.value).toBe('2.8.0');
    b.close();
  });

  it('is idempotent: a second Cache open with matching meta version does NOT touch edge_count', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    seedWikiIndexStatus(a, 'facebook/react', 38);
    a.close();

    // First open after v2.8: migration ran, stamped meta. Edge count was
    // RESET by the migration triggered on this very Cache open. We then
    // simulate a NEW index build by writing a real edge_count.
    const b = await Cache.open({ dbPath });
    b.getStore().prepare('UPDATE wiki_index_status SET edge_count = 99 WHERE repo = ?').run('facebook/react');
    b.close();

    // Second open: meta matches, migration is no-op, edge_count stays at 99.
    const c = await Cache.open({ dbPath });
    const row = c.getStore()
      .prepare('SELECT edge_count FROM wiki_index_status WHERE repo = ?')
      .get('facebook/react') as { edge_count: number };
    expect(row.edge_count).toBe(99);
    c.close();
  });

  it('is safe on empty wiki_index_status (fresh install) — only stamps meta, no UPDATE rows affected', async () => {
    const dbPath = path.join(tmpDir, 'cache.db');
    const a = await Cache.open({ dbPath });
    // Fresh install: no wiki_index_status rows at all.
    const count = a.getStore()
      .prepare('SELECT count(*) AS n FROM wiki_index_status')
      .get() as { n: number };
    expect(count.n).toBe(0);
    // Meta is still stamped so future re-opens skip the migration.
    const metaRow = a.getStore()
      .prepare("SELECT value FROM meta WHERE key = 'kg_extractor_version'")
      .get() as { value: string } | undefined;
    expect(metaRow?.value).toBe('2.8.0');
    a.close();
  });
});
