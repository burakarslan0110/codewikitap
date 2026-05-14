/**
 * VectorStore tests — exercise both the native (better-sqlite3) and the
 * in-memory fallback paths via FORCE_PUREJS_VECTOR + FORCE_INMEMORY_CACHE.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';
import { VectorStore } from '../../src/services/vector_store.js';
import { escapeBM25Query } from '../../src/services/fusion.js';
import type { IndexedChunk } from '../../src/types.js';

let tmpDir: string;
let cache: Cache;
let store: VectorStore;

const DIM = 4;
const NOW = Date.now();

function vec(values: number[]): Float32Array {
  const v = new Float32Array(values);
  // L2-normalize so cosine sim = dot product
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

function chunk(repo: string, sectionSlug: string, ordinal: number, embedding: Float32Array, text = ''): IndexedChunk {
  return {
    repo,
    pageSlug: '__root__',
    sectionSlug,
    ordinal,
    text: text || `text-${repo}-${sectionSlug}-${ordinal}`,
    embedding,
    indexedAt: NOW,
    commitSha: 'aabbccddeeff00112233445566778899aabbccdd',
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-vec-'));
  // Force pure-JS for the existing test fixtures — they use 4-dim vectors,
  // which would mismatch the production EMBED_MODEL_DIM=384 vec_chunks
  // virtual table. The native path is exercised by a dedicated test group
  // below using 384-dim vectors.
  process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
  cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
  store = new VectorStore(cache);
});

afterEach(() => {
  cache.close();
  delete process.env.CODEWIKI_FORCE_PUREJS_VECTOR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('VectorStore — upsert and query (basic)', () => {
  it('upsertChunks then queryChunks returns chunks ranked by cosine similarity', () => {
    const c1 = chunk('repo/a', 's1', 0, vec([1, 0, 0, 0]));
    const c2 = chunk('repo/a', 's2', 0, vec([0, 1, 0, 0]));
    store.upsertChunks([c1, c2]);

    const results = store.queryChunks('repo/a', vec([1, 0.1, 0, 0]), 2);
    expect(results.length).toBe(2);
    expect(results[0].sectionSlug).toBe('s1');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('chunkCountForRepo reflects the number of inserted chunks', () => {
    expect(store.chunkCountForRepo('repo/a')).toBe(0);
    store.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0])),
      chunk('repo/a', 's2', 0, vec([0, 1, 0, 0])),
    ]);
    expect(store.chunkCountForRepo('repo/a')).toBe(2);
  });

  it('queryChunks filters by repo (does not leak across repos)', () => {
    store.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0])),
      chunk('repo/b', 's1', 0, vec([1, 0, 0, 0])),
    ]);
    const results = store.queryChunks('repo/a', vec([1, 0, 0, 0]), 5);
    expect(results.length).toBe(1);
    expect(results[0].repo).toBe('repo/a');
  });

  it('dropRepo removes only that repo\'s chunks', () => {
    store.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0])),
      chunk('repo/b', 's1', 0, vec([1, 0, 0, 0])),
    ]);
    store.dropRepo('repo/a');
    expect(store.chunkCountForRepo('repo/a')).toBe(0);
    expect(store.chunkCountForRepo('repo/b')).toBe(1);
  });

  it('upsert is idempotent on the (repo, page_slug, section_slug, ordinal) primary key', () => {
    const c = chunk('repo/a', 's1', 0, vec([1, 0, 0, 0]));
    store.upsertChunks([c]);
    store.upsertChunks([c]);
    expect(store.chunkCountForRepo('repo/a')).toBe(1);
  });
});

describe('VectorStore — wiki_index_status', () => {
  it('upsertWikiIndexStatus then getWikiIndexStatus round-trips', () => {
    store.upsertWikiIndexStatus('repo/a', 'aabbccddeeff00112233445566778899aabbccdd', 7);
    const status = store.getWikiIndexStatus('repo/a');
    expect(status).not.toBeNull();
    expect(status!.commitSha).toBe('aabbccddeeff00112233445566778899aabbccdd');
    expect(status!.chunkCount).toBe(7);
    expect(status!.indexedAt).toBeGreaterThan(0);
  });

  it('getWikiIndexStatus returns null for an unknown repo', () => {
    expect(store.getWikiIndexStatus('repo/unknown')).toBeNull();
  });

  it('listIndexedRepos returns repos with a wiki_index_status row', () => {
    store.upsertWikiIndexStatus('repo/a', 'a'.repeat(40), 1);
    store.upsertWikiIndexStatus('repo/b', 'b'.repeat(40), 1);
    const repos = store.listIndexedRepos().sort();
    expect(repos).toEqual(['repo/a', 'repo/b']);
  });
});

describe('VectorStore — pure-JS fallback path (FORCE_PUREJS_VECTOR=1)', () => {
  beforeEach(async () => {
    process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
  });
  afterEach(() => {
    delete process.env.CODEWIKI_FORCE_PUREJS_VECTOR;
  });

  it('returns correct top-k under the pure-JS path', () => {
    // Re-create store under the env so it picks up the flag.
    const s = new VectorStore(cache);
    s.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0])),
      chunk('repo/a', 's2', 0, vec([0, 1, 0, 0])),
      chunk('repo/a', 's3', 0, vec([0, 0, 1, 0])),
    ]);
    const results = s.queryChunks('repo/a', vec([0, 1, 0, 0]), 2);
    expect(results[0].sectionSlug).toBe('s2');
  });
});

describe('VectorStore — in-memory cache path', () => {
  it('upsert + query work against the in-memory Cache', async () => {
    const inMem = await Cache.open({ forceInMemory: true });
    const s = new VectorStore(inMem);
    s.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0])),
      chunk('repo/a', 's2', 0, vec([0, 1, 0, 0])),
    ]);
    const results = s.queryChunks('repo/a', vec([1, 0, 0, 0]), 1);
    expect(results.length).toBe(1);
    expect(results[0].sectionSlug).toBe('s1');
    inMem.close();
  });

  it('hasSqliteVec === false on in-memory backend', async () => {
    const inMem = await Cache.open({ forceInMemory: true });
    const s = new VectorStore(inMem);
    expect(s.hasSqliteVec).toBe(false);
    inMem.close();
  });
});

/**
 * v2.6 native sqlite-vec path tests — use the production EMBED_MODEL_DIM=384
 * vector size so vec_chunks dual-write succeeds. Asserts native query parity
 * with pure-JS, dropRepo deletes from both tables, and the dim-swap
 * recreate flow works.
 */
describe('VectorStore — native sqlite-vec path (v2.6)', () => {
  const NATIVE_DIM = 384;

  function nativeVec(seed: number): Float32Array {
    const v = new Float32Array(NATIVE_DIM);
    // Sparse-ish unit vector: hot index varies with seed so different
    // chunks produce different vectors. L2-normalized at the hot index.
    v[seed % NATIVE_DIM] = 1;
    return v;
  }

  function nativeChunk(repo: string, sectionSlug: string, ordinal: number, seed: number): IndexedChunk {
    return {
      repo,
      pageSlug: '__root__',
      sectionSlug,
      ordinal,
      text: `text-${repo}-${sectionSlug}-${ordinal}`,
      embedding: nativeVec(seed),
      indexedAt: NOW,
      commitSha: 'aabbccddeeff00112233445566778899aabbccdd',
    };
  }

  let nativeTmpDir: string;
  let nativeCache: Cache;
  let nativeStore: VectorStore;

  beforeEach(async () => {
    nativeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-vec-native-'));
    // Make sure FORCE_PUREJS is OFF for this group so the native path engages.
    delete process.env.CODEWIKI_FORCE_PUREJS_VECTOR;
    nativeCache = await Cache.open({ dbPath: path.join(nativeTmpDir, 'cache.db') });
    nativeStore = new VectorStore(nativeCache);
  });

  afterEach(() => {
    nativeCache.close();
    fs.rmSync(nativeTmpDir, { recursive: true, force: true });
  });

  it('hasSqliteVec === true on a fresh disk-backed cache (v6 migration succeeded)', () => {
    expect(nativeStore.hasSqliteVec).toBe(true);
  });

  it('upsertChunks dual-writes to chunks AND vec_chunks (parity invariant)', () => {
    nativeStore.upsertChunks([
      nativeChunk('repo/a', 's1', 0, 0),
      nativeChunk('repo/a', 's2', 0, 1),
      nativeChunk('repo/a', 's3', 0, 2),
    ]);
    const sqlStore = nativeCache.getStore();
    const chunkCount = Number(sqlStore.prepare('SELECT count(*) AS n FROM chunks').get()?.n);
    const vecCount = Number(sqlStore.prepare('SELECT count(*) AS n FROM vec_chunks').get()?.n);
    expect(chunkCount).toBe(3);
    expect(vecCount).toBe(3);
    // Parity invariant: every chunks row has a matching vec_chunks row.
    const orphans = sqlStore
      .prepare(
        'SELECT chunks.rowid AS r FROM chunks LEFT JOIN vec_chunks ON vec_chunks.rowid = chunks.rowid WHERE vec_chunks.rowid IS NULL',
      )
      .all();
    expect(orphans).toHaveLength(0);
  });

  it('queryChunks returns top-k via native vec_distance_cosine', () => {
    nativeStore.upsertChunks([
      nativeChunk('repo/a', 's1', 0, 0), // hot at index 0
      nativeChunk('repo/a', 's2', 0, 1), // hot at index 1
      nativeChunk('repo/a', 's3', 0, 2), // hot at index 2
    ]);
    const results = nativeStore.queryChunks('repo/a', nativeVec(1), 2);
    expect(results.length).toBe(2);
    // Closest to nativeVec(1) is s2; ranking holds via cosine.
    expect(results[0].sectionSlug).toBe('s2');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('dropRepo removes both chunks AND vec_chunks rows for that repo', () => {
    nativeStore.upsertChunks([
      nativeChunk('repo/a', 's1', 0, 0),
      nativeChunk('repo/b', 's1', 0, 1),
    ]);
    nativeStore.dropRepo('repo/a');
    const sqlStore = nativeCache.getStore();
    expect(Number(sqlStore.prepare('SELECT count(*) AS n FROM chunks WHERE repo = ?').get('repo/a')?.n)).toBe(0);
    expect(Number(sqlStore.prepare('SELECT count(*) AS n FROM chunks WHERE repo = ?').get('repo/b')?.n)).toBe(1);
    // vec_chunks parity preserved.
    const orphans = sqlStore
      .prepare(
        'SELECT chunks.rowid AS r FROM chunks LEFT JOIN vec_chunks ON vec_chunks.rowid = chunks.rowid WHERE vec_chunks.rowid IS NULL',
      )
      .all();
    expect(orphans).toHaveLength(0);
  });

  it('dropAllChunks() deletes from both tables in one transaction', () => {
    nativeStore.upsertChunks([
      nativeChunk('repo/a', 's1', 0, 0),
      nativeChunk('repo/b', 's1', 0, 1),
    ]);
    nativeStore.upsertWikiIndexStatus('repo/a', 'a'.repeat(40), 1);
    nativeStore.upsertWikiIndexStatus('repo/b', 'b'.repeat(40), 1);
    nativeStore.dropAllChunks();
    const sqlStore = nativeCache.getStore();
    expect(Number(sqlStore.prepare('SELECT count(*) AS n FROM chunks').get()?.n)).toBe(0);
    expect(Number(sqlStore.prepare('SELECT count(*) AS n FROM vec_chunks').get()?.n)).toBe(0);
    expect(Number(sqlStore.prepare('SELECT count(*) AS n FROM wiki_index_status').get()?.n)).toBe(0);
  });

  it('dropAllChunks({ recreateVecChunksDim }) DROPs and recreates vec_chunks with new dim', () => {
    nativeStore.upsertChunks([nativeChunk('repo/a', 's1', 0, 0)]);
    nativeStore.upsertWikiIndexStatus('repo/a', 'a'.repeat(40), 1);

    // Recreate at 768 dim (simulates an embedder model swap).
    nativeStore.dropAllChunks({ recreateVecChunksDim: 768 });

    const sqlStore = nativeCache.getStore();
    // The new vec_chunks accepts 768-dim vectors. Insert a 768-dim vector
    // directly via the raw store to confirm the schema change.
    const newVec = new Float32Array(768);
    newVec[42] = 1;
    expect(() =>
      sqlStore
        .prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)')
        .run(1n, Buffer.from(newVec.buffer)),
    ).not.toThrow();
    // 384-dim insert against the 768-dim schema must fail loudly.
    const oldVec = new Float32Array(384);
    oldVec[10] = 1;
    expect(() =>
      sqlStore
        .prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)')
        .run(2n, Buffer.from(oldVec.buffer)),
    ).toThrow();
  });

  it('upsertChunks throws when chunk embedding length != EMBED_MODEL_DIM', () => {
    const wrongDim = new Float32Array(128); // wrong dim
    wrongDim[0] = 1;
    const c: IndexedChunk = {
      repo: 'repo/a',
      pageSlug: '__root__',
      sectionSlug: 's1',
      ordinal: 0,
      text: 'x',
      embedding: wrongDim,
      indexedAt: NOW,
      commitSha: 'aabbccddeeff00112233445566778899aabbccdd',
    };
    expect(() => nativeStore.upsertChunks([c])).toThrow(/embedding length 128 != EMBED_MODEL_DIM 384/);
  });
});

describe('VectorStore v2.7 — BM25 (FTS5) tri-write + query + drop', () => {
  let bmTmpDir: string;
  let bmCache: Cache;
  let bmStore: VectorStore;

  beforeEach(async () => {
    bmTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-bm25-'));
    // Force pure-JS for vector (test fixtures use 4-dim); FTS5 still backfills
    // and queries independently of the vector path.
    process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
    delete process.env.CODEWIKI_FORCE_NO_BM25;
    bmCache = await Cache.open({ dbPath: path.join(bmTmpDir, 'cache.db') });
    bmStore = new VectorStore(bmCache);
  });

  afterEach(() => {
    bmCache.close();
    delete process.env.CODEWIKI_FORCE_PUREJS_VECTOR;
    delete process.env.CODEWIKI_FORCE_NO_BM25;
    fs.rmSync(bmTmpDir, { recursive: true, force: true });
  });

  it('hasBm25 reflects Cache.ftsAvailable when CODEWIKI_FORCE_NO_BM25 is unset', () => {
    expect(bmCache.ftsAvailable).toBe(true);
    expect(bmStore.hasBm25()).toBe(true);
  });

  it('upsertChunks tri-writes to fts_chunks (parity invariant: chunks count == fts_chunks count)', () => {
    bmStore.upsertChunks([
      chunk('repo/a', 'auth', 0, vec([1, 0, 0, 0]), 'authentication setup flow'),
      chunk('repo/a', 'hooks', 0, vec([0, 1, 0, 0]), 'useState hook example'),
      chunk('repo/a', 'hooks', 1, vec([0, 0, 1, 0]), 'useEffect hook example'),
    ]);

    const innerStore = bmCache.getStore();
    const chunkCount = Number(innerStore.prepare('SELECT count(*) AS n FROM chunks WHERE repo = ?').get('repo/a')?.n);
    const ftsCount = Number(
      innerStore
        .prepare('SELECT count(*) AS n FROM fts_chunks WHERE rowid IN (SELECT rowid FROM chunks WHERE repo = ?)')
        .get('repo/a')?.n,
    );
    expect(chunkCount).toBe(3);
    expect(ftsCount).toBe(3);
  });

  it('queryChunksBM25 returns chunks ranked by BM25 score desc (inverted from raw bm25())', () => {
    bmStore.upsertChunks([
      chunk('repo/a', 'auth', 0, vec([1, 0, 0, 0]), 'authentication setup flow'),
      chunk('repo/a', 'hooks', 0, vec([0, 1, 0, 0]), 'useState hook example'),
      chunk('repo/a', 'hooks', 1, vec([0, 0, 1, 0]), 'useEffect hook example'),
    ]);

    const result = bmStore.queryChunksBM25('repo/a', 'hook', 0, 5);
    expect(result.total).toBe(2);
    expect(result.rows.length).toBe(2);
    // Both hook chunks should be in result; ordering is by inverted bm25
    const slugs = result.rows.map((r) => r.sectionSlug).sort();
    expect(slugs).toEqual(['hooks', 'hooks']);
    // Score should be a positive number (we invert bm25's negative scale).
    expect(result.rows[0].score).toBeGreaterThan(0);
  });

  it('queryChunksBM25 honors offset + k pagination', () => {
    bmStore.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0]), 'hook one'),
      chunk('repo/a', 's2', 0, vec([0, 1, 0, 0]), 'hook two'),
      chunk('repo/a', 's3', 0, vec([0, 0, 1, 0]), 'hook three'),
    ]);

    const page1 = bmStore.queryChunksBM25('repo/a', 'hook', 0, 2);
    expect(page1.total).toBe(3);
    expect(page1.rows.length).toBe(2);

    const page2 = bmStore.queryChunksBM25('repo/a', 'hook', 2, 2);
    expect(page2.total).toBe(3);
    expect(page2.rows.length).toBe(1);
  });

  it('queryChunksBM25 filters by repo', () => {
    bmStore.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0]), 'hook content'),
      chunk('repo/b', 's1', 0, vec([1, 0, 0, 0]), 'hook content'),
    ]);
    const result = bmStore.queryChunksBM25('repo/a', 'hook', 0, 5);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].repo).toBe('repo/a');
  });

  it('queryChunksBM25 throws on empty query (caller responsibility)', () => {
    expect(() => bmStore.queryChunksBM25('repo/a', '   ', 0, 5)).toThrow(/non-empty query/);
  });

  it('escapeBM25Query + queryChunksBM25 returns rows for multi-token queries (RRF high-recall contract)', () => {
    // v0.5.2 regression test: prior escape rejoined tokens with a bare
    // space, which FTS5 treats as implicit AND. A natural-language query
    // like "hook authentication" required BOTH tokens in one chunk and
    // returned zero rows — the BM25 lane silently went empty under RRF.
    // With OR-join, each token contributes; BM25 ranking still favors
    // chunks matching more tokens.
    bmStore.upsertChunks([
      chunk('repo/a', 'auth', 0, vec([1, 0, 0, 0]), 'authentication setup flow'),
      chunk('repo/a', 'hooks', 0, vec([0, 1, 0, 0]), 'useState hook example'),
      chunk('repo/a', 'rendering', 0, vec([0, 0, 1, 0]), 'rendering pipeline overview'),
    ]);

    // No single chunk contains BOTH "hook" and "authentication".
    const escaped = escapeBM25Query('hook authentication');
    const result = bmStore.queryChunksBM25('repo/a', escaped, 0, 10);

    expect(result.total).toBe(2);
    const slugs = result.rows.map((r) => r.sectionSlug).sort();
    expect(slugs).toEqual(['auth', 'hooks']);
  });

  it('dropRepo clears fts_chunks rows for that repo', () => {
    bmStore.upsertChunks([
      chunk('repo/a', 's1', 0, vec([1, 0, 0, 0]), 'hook'),
      chunk('repo/b', 's1', 0, vec([1, 0, 0, 0]), 'hook'),
    ]);
    bmStore.dropRepo('repo/a');

    const innerStore = bmCache.getStore();
    const ftsRemaining = Number(
      innerStore
        .prepare('SELECT count(*) AS n FROM fts_chunks WHERE rowid IN (SELECT rowid FROM chunks)')
        .get()?.n,
    );
    // Only repo/b's row remains.
    expect(ftsRemaining).toBe(1);
  });

  it('hasBm25 returns false when CODEWIKI_FORCE_NO_BM25=1 is set at construction', () => {
    process.env.CODEWIKI_FORCE_NO_BM25 = '1';
    const escapedStore = new VectorStore(bmCache);
    expect(escapedStore.hasBm25()).toBe(false);
  });
});
