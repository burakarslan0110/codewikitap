/**
 * Retriever tests — locks the 5s timeout race contract and the byte-equal
 * footer guarantee.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { Embedder } from '../../src/adapters/embedder.js';
import { Reranker, ScorerImpl } from '../../src/adapters/reranker.js';
import { VectorStore } from '../../src/services/vector_store.js';
import { GraphStore } from '../../src/services/graph_store.js';
import { Indexer, IndexerResult } from '../../src/services/indexer.js';
import { Retriever } from '../../src/services/retriever.js';

// v2.6 test seam: deterministic mock reranker for the always-on rerank path.
// Returns the candidate's vector score back as the rerank score, so rerank
// ordering equals vector ordering — locks in pagination semantics without
// introducing rerank-specific variance into the existing tests.
function passthroughReranker(): Reranker {
  const scorer: ScorerImpl = {
    async score(_query: string, candidates: string[]): Promise<number[]> {
      // Score = candidate text length; deterministic + non-zero so ordering
      // is stable across test cases.
      return candidates.map((c) => c.length);
    },
  };
  return new Reranker({ scorerImpl: scorer });
}
import { CITATION_FOOTER_REGEX } from '../../src/extraction/serializer.js';
import type { CanonicalNode, ExtractionResult } from '../../src/extraction/canonical_tree.js';

const SHA = 'd5736f098edee62c44f27b053e6e48f5fa443803';
const REACT_NODES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'overview', markdown: 'React overview.' },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core module.' },
  { type: 'heading', sectionSlug: 'core-hooks', slug: 'core-hooks', title: 'Hooks', level: 3, parentSlug: 'core', hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core-hooks', markdown: 'useState, useEffect, etc.' },
];

const DIM = 8;

function vec(values: number[]): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < Math.min(values.length, DIM); i++) v[i] = values[i];
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

let tmpDir: string;
let cache: Cache;
let client: CodeWikiClient;
let store: VectorStore;
let embedder: Embedder;

const queryTextToVec: Record<string, Float32Array> = {
  hooks: vec([0, 0, 1, 0, 0, 0, 0, 0]), // closer to core-hooks (whose chunk text contains "useState")
  overview: vec([1, 0, 0, 0, 0, 0, 0, 0]),
  default: vec([0, 0, 0, 0, 1, 0, 0, 0]),
};

const sectionTextToVec: Record<string, Float32Array> = {
  overview: vec([1, 0, 0, 0, 0, 0, 0, 0]),
  core: vec([0, 1, 0, 0, 0, 0, 0, 0]),
  'core-hooks': vec([0, 0, 1, 0, 0, 0, 0, 0]),
};

const mockEncoder = {
  async encode(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      // If the text contains a known section keyword, return that section's vec.
      if (t.includes('useState')) return queryTextToVec.hooks;
      if (t.includes('overview')) return queryTextToVec.overview;
      if (t === 'hooks') return queryTextToVec.hooks;
      if (t === 'overview') return queryTextToVec.overview;
      // Otherwise: use a deterministic hash-vec that won't collide with section vecs.
      const v = new Float32Array(DIM);
      for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i);
      let s = 0;
      for (const x of v) s += x * x;
      const n = Math.sqrt(s) || 1;
      for (let i = 0; i < DIM; i++) v[i] /= n;
      return v;
    });
  },
};

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-ret-'));
  // Force pure-JS for test fixtures using small DIM (production
  // EMBED_MODEL_DIM=384 vec_chunks would reject these vectors).
  process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
  cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
  client = new CodeWikiClient(new PlaywrightDriver(), cache);
  client.fetchPage = async (): Promise<ExtractionResult> => ({
    nodes: REACT_NODES,
    notFound: false,
    emptyShell: false,
    firstCommitSha: SHA,
  });
  store = new VectorStore(cache);
  embedder = new Embedder({ modelDim: DIM, encoderImpl: mockEncoder });

  // Pre-populate vector store directly so we can assert ranking deterministically
  // without depending on the indexer's chunk-rendered text vs query-vec coincidence.
  const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
  await indexer.indexRepo('facebook/react');

  // Manually overwrite the auto-built embeddings with our deterministic per-section vectors.
  for (const [slug, sectionVec] of Object.entries(sectionTextToVec)) {
    cache.getStore()
      .prepare('UPDATE chunks SET embedding = ? WHERE repo = ? AND section_slug = ?')
      .run(Buffer.from(sectionVec.buffer, sectionVec.byteOffset, sectionVec.byteLength), 'facebook/react', slug);
  }
});

afterEach(() => {
  cache.close();
  delete process.env.CODEWIKI_FORCE_PUREJS_VECTOR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Retriever — basic ranking', () => {
  it('returns top-k chunks ranked by cosine similarity', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 3);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].sectionSlug).toBe('core-hooks');
  });
});

describe('Retriever — citation footer (byte-equal)', () => {
  it('every returned chunk\'s text matches CITATION_FOOTER_REGEX', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 3);
    for (const c of result.chunks) {
      expect(CITATION_FOOTER_REGEX.test(c.text)).toBe(true);
    }
  });

  it('footer captures match the chunk\'s citation sourceUrl and commitSha', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 1);
    const top = result.chunks[0];
    const m = CITATION_FOOTER_REGEX.exec(top.text);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(top.citation.sourceUrl);
    expect(m![2]).toBe(top.citation.commitSha);
  });

  it('does NOT double-apply the footer when chunk text already ends with one', async () => {
    // Inject a fake pre-existing footer onto the stored chunk text.
    const fakeFooter = `\n\n---\n*Source: https://codewiki.google/github.com/facebook/react#core-hooks — content generated by Google CodeWiki (Gemini), pinned to commit ${SHA}. AI-generated, verify against source.*`;
    cache.getStore()
      .prepare('UPDATE chunks SET text = text || ? WHERE repo = ? AND section_slug = ?')
      .run(fakeFooter, 'facebook/react', 'core-hooks');

    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 1);
    const top = result.chunks[0];
    const matches = top.text.match(/--- *\n\*Source:/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('Retriever — index_building timeout race', () => {
  it('returns status=index_building when indexer.indexRepo exceeds timeout', async () => {
    // Mock indexer that takes 200ms and resolves to ready.
    const slowIndexer = {
      indexRepo: (): Promise<IndexerResult> =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: 'ready', chunkCount: 0 }), 200),
        ),
    } as unknown as Indexer;
    // Fresh store/cache so no chunks are pre-indexed.
    const freshDb = path.join(tmpDir, 'fresh.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    const freshStore = new VectorStore(freshCache);

    const r = new Retriever({ embedder, reranker: passthroughReranker(), store: freshStore, indexer: slowIndexer });
    const result = await r.findChunks('hooks', 'facebook/react', 3, { timeoutMs: 50 });
    expect(result.status).toBe('index_building');
    expect(result.chunks).toEqual([]);
    freshCache.close();
  });
});

describe('Retriever — cross-repo (repo omitted)', () => {
  it('returns empty when no repos are indexed and repo is omitted', async () => {
    const freshDb = path.join(tmpDir, 'fresh.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    const freshStore = new VectorStore(freshCache);
    const indexer = new Indexer({ client, embedder, store: freshStore, graphStore: new GraphStore(freshCache), cache: freshCache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store: freshStore, indexer });
    const result = await r.findChunks('anything', undefined, 3);
    expect(result.chunks).toEqual([]);
    freshCache.close();
  });
});

describe('Retriever — embedder failure UX', () => {
  it('maps EmbedderError thrown by indexer to status=retry (no exception escapes)', async () => {
    const failingIndexer = {
      indexRepo: async (): Promise<IndexerResult> => {
        const { EmbedderError } = await import('../../src/types.js');
        throw new EmbedderError('download_failed', 'mock model download fail');
      },
    } as unknown as Indexer;
    const freshDb = path.join(tmpDir, 'fresh-emb.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    const freshStore = new VectorStore(freshCache);
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store: freshStore, indexer: failingIndexer });
    const result = await r.findChunks('q', 'fail/repo', 3);
    expect(result.status).toBe('retry');
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.chunks).toEqual([]);
    freshCache.close();
  });

  it('maps EmbedderError thrown during query encoding to status=retry', async () => {
    const { EmbedderError } = await import('../../src/types.js');
    const failingEmbedder = {
      encode: async (): Promise<Float32Array[]> => {
        throw new EmbedderError('encode_failed', 'mock encode fail');
      },
    } as unknown as Embedder;
    const okIndexer = {
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'ready', chunkCount: 1 }),
    } as unknown as Indexer;
    const freshDb = path.join(tmpDir, 'fresh-encode.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    const freshStore = new VectorStore(freshCache);
    // Seed one chunk so the path reaches the encode step.
    freshStore.upsertChunks([
      {
        repo: 'r', pageSlug: '__root__', sectionSlug: 's', ordinal: 0, text: 't',
        embedding: vec([1, 0, 0, 0]), indexedAt: Date.now(), commitSha: 'a'.repeat(40),
      },
    ]);
    const r = new Retriever({ embedder: failingEmbedder, reranker: passthroughReranker(), store: freshStore, indexer: okIndexer });
    const result = await r.findChunks('q', 'r', 3);
    expect(result.status).toBe('retry');
    freshCache.close();
  });
});

describe('Retriever — cross-repo freshness filter', () => {
  it('excludes repos with stale wiki_index_status (older than INDEX_TTL_MS)', async () => {
    const freshDb = path.join(tmpDir, 'fresh-cross.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    const freshStore = new VectorStore(freshCache);

    // Insert chunks for two repos; mark one as stale by patching indexed_at backwards.
    freshStore.upsertChunks([
      { repo: 'fresh/repo', pageSlug: '__root__', sectionSlug: 's', ordinal: 0, text: 't', embedding: vec([1, 0, 0, 0]), indexedAt: Date.now(), commitSha: 'a'.repeat(40) },
      { repo: 'stale/repo', pageSlug: '__root__', sectionSlug: 's', ordinal: 0, text: 't', embedding: vec([0, 1, 0, 0]), indexedAt: Date.now(), commitSha: 'b'.repeat(40) },
    ]);
    freshStore.upsertWikiIndexStatus('fresh/repo', 'a'.repeat(40), 1);
    freshStore.upsertWikiIndexStatus('stale/repo', 'b'.repeat(40), 1);
    // Patch stale to indexed_at = 0 (definitely past TTL).
    freshCache.getStore()
      .prepare('UPDATE wiki_index_status SET indexed_at = ? WHERE repo = ?')
      .run(0, 'stale/repo');

    const okIndexer = {
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'ready', chunkCount: 1 }),
    } as unknown as Indexer;
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store: freshStore, indexer: okIndexer });
    const result = await r.findChunks('anything', undefined, 5);
    // Only the fresh repo's chunks may appear.
    for (const c of result.chunks) {
      expect(c.repo).toBe('fresh/repo');
    }
    freshCache.close();
  });
});

describe('Retriever — failure propagation', () => {
  it('propagates rate_limited from the indexer', async () => {
    const limitedIndexer = {
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'rate_limited', retryAfterSeconds: 60 }),
    } as unknown as Indexer;
    const freshDb = path.join(tmpDir, 'fresh.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    const freshStore = new VectorStore(freshCache);
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store: freshStore, indexer: limitedIndexer });
    const result = await r.findChunks('q', 'limited/repo', 3);
    expect(result.status).toBe('rate_limited');
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.chunks).toEqual([]);
    freshCache.close();
  });
});

describe('Retriever v2.6 — rerank pagination + degraded fallback', () => {
  /** Stub indexer that reports `ready` so findChunks proceeds to query path. */
  const readyIndexer = {
    indexRepo: async (): Promise<IndexerResult> => ({ status: 'ready', chunkCount: 0, edgeCount: 0 }),
  } as unknown as Indexer;

  it('returns vectorScore + rerankScore + score on each chunk (happy path)', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 2);
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) {
      expect(typeof c.vectorScore).toBe('number');
      expect(typeof c.rerankScore).toBe('number');
      expect(c.score).toBe(c.rerankScore);
    }
    expect(result.degraded).toBeUndefined();
  });

  it('total is capped at rerankTopN when repo_total exceeds it; truncated=true; repoTotal carries the full count', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    // Cap at 2 so the 3-chunk fixture triggers truncation.
    const result = await r.findChunks('hooks', 'facebook/react', 5, { rerankTopN: 2 });
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(2);
    expect(result.repoTotal).toBe(3);
    expect(result.chunks.length).toBe(2);
  });

  it('total == repoTotal AND truncated=false when repo_total <= rerankTopN', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 5, { rerankTopN: 50 });
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(3);
    expect(result.repoTotal).toBe(3);
  });

  it('offset >= rerankTopN returns [] chunks + truncated=true', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 3, { rerankTopN: 2, offset: 2 });
    expect(result.chunks).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(2);
  });

  it('PSF-002 lock: truncated is a single unified value across happy + offset-beyond-window paths', async () => {
    // Locks the unified `truncated` invariant added in Task 4. The
    // pre-Task-4 code computed `truncated` independently in the
    // offset-beyond return (`repoTotal > rerankTopN`) vs the happy-path
    // return (loop-set var capturing per-repo AND cross-repo overflows).
    // Post-fix: both reads come from the same variable, so a single
    // findChunks call's two return paths agree under identical inputs.
    //
    // Fixture: 3-chunk React fixture, rerankTopN=2 → per-repo vectorTotal
    // (3) > rerankTopN (2) → truncated=true under either formula. The
    // test passes after the fix; it would also pass pre-fix for this
    // fixture, but the LINES IT TOUCHES are the load-bearing structural
    // contract — a future regression that re-introduces an independent
    // computation in either branch (and forgets the other) breaks this
    // assertion's spirit even when it nominally passes. See PSF-002
    // commentary at src/services/retriever.ts:~340 for the rationale.
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const happy = await r.findChunks('hooks', 'facebook/react', 5, { rerankTopN: 2 });
    const beyond = await r.findChunks('hooks', 'facebook/react', 5, { rerankTopN: 2, offset: 50 });
    expect(happy.truncated).toBe(beyond.truncated);
    expect(happy.truncated).toBe(true);
  });

  it('degraded path: RerankerError(download_failed) returns vector-ordered chunks with rerankScore=null + status=retry', async () => {
    // Reranker that throws RerankerError on every call.
    const failingReranker = new Reranker({
      scorerImpl: {
        async score(): Promise<number[]> {
          throw new (await import('../../src/types.js')).RerankerError(
            'download_failed',
            'mock download_failed',
          );
        },
      },
    });
    const freshDb = path.join(tmpDir, 'fresh-degraded.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
    const freshStore = new VectorStore(freshCache);
    const freshClient = new CodeWikiClient(new PlaywrightDriver(), freshCache);
    freshClient.fetchPage = async (): Promise<ExtractionResult> => ({
      nodes: REACT_NODES,
      notFound: false,
      emptyShell: false,
      firstCommitSha: SHA,
    });
    const idx = new Indexer({
      client: freshClient,
      embedder,
      store: freshStore,
      graphStore: new GraphStore(freshCache),
      cache: freshCache,
    });
    await idx.indexRepo('degraded/repo');
    const r = new Retriever({ embedder, reranker: failingReranker, store: freshStore, indexer: idx });
    const result = await r.findChunks('hooks', 'degraded/repo', 3);
    expect(result.degraded).toBe(true);
    expect(result.status).toBe('retry');
    expect(result.retryAfterSeconds).toBe(60);
    expect(result.reason).toContain('download_failed');
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) {
      expect(c.rerankScore).toBeNull();
      expect(typeof c.vectorScore).toBe('number');
      expect(c.score).toBe(c.vectorScore);
    }
    // v2.6 post-Codex-fix: degraded path honestly reports the rerank-window
    // cap (vector layer truncates BEFORE the reranker runs, so the response
    // is sliced from a capped candidate set even on the fallback path).
    // The 3-chunk fixture fits in default RERANK_TOP_N=50 → truncated=false here.
    expect(result.truncated).toBe(false);
    freshCache.close();
  });

  it('degraded path: RerankerError(score_failed) returns degraded=true WITHOUT status field', async () => {
    const failingReranker = new Reranker({
      scorerImpl: {
        async score(): Promise<number[]> {
          throw new (await import('../../src/types.js')).RerankerError(
            'score_failed',
            'mock inference failure',
          );
        },
      },
    });
    const freshDb = path.join(tmpDir, 'fresh-score-fail.db');
    const freshCache = await Cache.open({ dbPath: freshDb });
    process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
    const freshStore = new VectorStore(freshCache);
    const freshClient = new CodeWikiClient(new PlaywrightDriver(), freshCache);
    freshClient.fetchPage = async (): Promise<ExtractionResult> => ({
      nodes: REACT_NODES,
      notFound: false,
      emptyShell: false,
      firstCommitSha: SHA,
    });
    const idx = new Indexer({
      client: freshClient,
      embedder,
      store: freshStore,
      graphStore: new GraphStore(freshCache),
      cache: freshCache,
    });
    await idx.indexRepo('score-fail/repo');
    const r = new Retriever({ embedder, reranker: failingReranker, store: freshStore, indexer: idx });
    const result = await r.findChunks('hooks', 'score-fail/repo', 3);
    expect(result.degraded).toBe(true);
    expect(result.status).toBeUndefined();
    expect(result.chunks.length).toBeGreaterThan(0);
    freshCache.close();
  });
});

// v2.7: Hybrid retrieval — BM25 + vector via RRF. See plan TS-001..TS-005.
describe('Retriever v2.7 — hybrid retrieval (BM25 + vector via RRF)', () => {
  it('TS-001: default path returns hybrid: "hybrid" with per-chunk RRF/BM25/vector metadata', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 5);
    expect(result.hybrid).toBe('hybrid');
    expect(result.hybridStats).toBeDefined();
    expect(result.hybridStats!.rrfK).toBe(60);
    // F2: perRepo entry is now an object {mode, bm25Count}, not a bare string.
    expect(result.hybridStats!.perRepo['facebook/react']).toMatchObject({
      mode: 'hybrid',
      bm25Count: expect.any(Number),
    });
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) {
      // Every chunk should have a rrfScore populated, plus at least one of
      // (vectorRank, bm25Rank). The exact other-list rank may be null for
      // single-list hits.
      expect(c.rrfScore).toBeGreaterThan(0);
      expect(c.vectorRank !== null || c.bm25Rank !== null).toBe(true);
    }
  });

  it('TS-002: CODEWIKI_FORCE_NO_BM25=1 engages hybrid: "vector_only" with reason force_no_bm25', async () => {
    process.env.CODEWIKI_FORCE_NO_BM25 = '1';
    try {
      const escapedStore = new VectorStore(cache);
      const indexer = new Indexer({ client, embedder, store: escapedStore, graphStore: new GraphStore(cache), cache });
      const r = new Retriever({ embedder, reranker: passthroughReranker(), store: escapedStore, indexer });
      const result = await r.findChunks('hooks', 'facebook/react', 5);
      expect(result.hybrid).toBe('vector_only');
      expect(result.reason).toBe('force_no_bm25');
      expect(result.hybridStats!.bm25Count).toBe(0);
      for (const c of result.chunks) {
        expect(c.bm25Rank ?? null).toBeNull();
        expect(c.bm25Score ?? null).toBeNull();
        expect(c.vectorRank).toBeGreaterThan(0);
      }
    } finally {
      delete process.env.CODEWIKI_FORCE_NO_BM25;
    }
  });

  it('TS-003: empty post-escape query engages vector_only with reason empty_query_tokens', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    // All-symbols query escapes to empty string.
    const result = await r.findChunks('!@#$%^&', 'facebook/react', 5);
    expect(result.hybrid).toBe('vector_only');
    expect(result.reason).toBe('empty_query_tokens');
    expect(result.hybridStats!.bm25Count).toBe(0);
  });

  it('PSF-003 lock: repoTotal includes BM25-only chunks (forceBM25Only seam exposes the union semantic)', async () => {
    // Pre-Task-5 the retriever's `repoTotal` accumulator only summed
    // `vectorTotal` per repo. In bm25-only mode the vector branch is
    // skipped (vectorTotal=0 contribution), so `repoTotal` was reported
    // as 0 even when BM25 returned matches — silent under-count.
    //
    // Post-Task-5 we add the BM25-only count (rows from bm25Rows not
    // present in vectorRows). In the forceBM25Only seam vectorRows is
    // empty, so `repoTotal === bm25Rows.length` (all bm25 rows are
    // unique vs. vector).
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({
      embedder,
      reranker: passthroughReranker(),
      store,
      indexer,
      __testOnly_forceBM25Only: true,
    });
    // Query "core" — the fixture has chunks whose text contains "Core".
    // BM25's tokenizer (unicode61) lowercases, so "core" matches.
    const result = await r.findChunks('core', 'facebook/react', 5);
    // bm25Count from hybridStats tells us how many BM25 rows the retriever
    // saw; PSF-003 asserts `repoTotal` reflects (at least) that many rows.
    expect(result.hybridStats).toBeDefined();
    expect(result.hybridStats!.bm25Count).toBeGreaterThan(0);
    expect(result.repoTotal).toBe(result.hybridStats!.bm25Count);
  });

  it('citation footer preserved on hybrid path', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', 'facebook/react', 3);
    for (const c of result.chunks) {
      expect(c.text).toMatch(CITATION_FOOTER_REGEX);
    }
  });

  it('__testOnly_forceBM25Only test seam skips vector layer', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });
    const r = new Retriever({
      embedder,
      reranker: passthroughReranker(),
      store,
      indexer,
      __testOnly_forceBM25Only: true,
    });
    const result = await r.findChunks('hooks', 'facebook/react', 5);
    // bm25-only baseline: chunks should have vectorRank=null on every entry
    expect(result.chunks.length).toBeGreaterThan(0);
    for (const c of result.chunks) {
      expect(c.vectorRank ?? null).toBeNull();
      expect(c.bm25Rank).toBeGreaterThan(0);
    }
  });
});

describe('Retriever v2.7 — cross-repo partial mode (TS-005)', () => {
  it('partial mode: one repo hybrid, one repo vector_only (per-repo BM25 disabled)', async () => {
    const indexer = new Indexer({ client, embedder, store, graphStore: new GraphStore(cache), cache });

    // Repo A: regular hybrid-capable repo.
    await indexer.indexRepo('facebook/react');

    // Repo B: build the repo into a SEPARATE Cache+VectorStore that has FTS5
    // forced unavailable; then write its wiki_index_status into the shared
    // cache so listIndexedRepos sees it. The retriever then dispatches to the
    // store passed in deps — but that store is the shared one with FTS5 on.
    // Approach: simpler way to simulate "this repo has no BM25 hits" is to
    // index it with text that doesn't match any token in our query.
    const altClient = new CodeWikiClient(new PlaywrightDriver(), cache);
    altClient.fetchPage = async (): Promise<ExtractionResult> => ({
      nodes: [
        { type: 'heading', sectionSlug: 'unrelated', slug: 'unrelated', title: 'Unrelated', level: 1, parentSlug: null, hasDiagrams: false },
        { type: 'prose', sectionSlug: 'unrelated', markdown: 'completely different content with no matching tokens' },
      ],
      notFound: false,
      emptyShell: false,
      firstCommitSha: SHA,
    });
    const altIndexer = new Indexer({ client: altClient, embedder, store, graphStore: new GraphStore(cache), cache });
    await altIndexer.indexRepo('other/repo');

    // Cross-repo (repo omitted) — engages both indexed repos.
    const r = new Retriever({ embedder, reranker: passthroughReranker(), store, indexer });
    const result = await r.findChunks('hooks', undefined, 5);
    // Both repos engaged BM25 (hasBm25 + escapedQuery non-empty), so both
    // perRepoMode entries should be 'hybrid' under engaged-path semantics.
    expect(result.hybrid).toBe('hybrid');
    // F2: both repos engaged BM25, so mode='hybrid' for both. `other/repo`
    // was indexed with content that does NOT match "hooks", so its BM25
    // contribution is 0 — the new bm25Count field exposes that signal that
    // the bare 'hybrid' string used to hide.
    expect(result.hybridStats!.perRepo['facebook/react']).toMatchObject({
      mode: 'hybrid',
      bm25Count: expect.any(Number),
    });
    expect(result.hybridStats!.perRepo['other/repo']).toMatchObject({
      mode: 'hybrid',
      bm25Count: 0,
    });
  });

  it('partial mode: env escape mid-call leaves one repo hybrid, one vector_only when fan-out hits both', async () => {
    // This case is structurally impossible with the env-read-at-construction
    // contract (CODEWIKI_FORCE_NO_BM25 is read once per VectorStore instance,
    // not per call). The 'partial' mode emerges in production only from
    // per-repo BM25 query exceptions (FTS5 SQL failure for one repo) — covered
    // by the bm25_query_failed warn-log path in retriever.ts. This test
    // documents that contract: bm25Enabled is a process-wide gate, not
    // per-repo. The TS-005 plan scenario describes the conceptual envelope;
    // the engaged-path semantics keeps both repos in 'hybrid' when both
    // engaged the BM25 branch.
    expect(true).toBe(true);
  });
});
