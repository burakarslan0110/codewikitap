/**
 * Indexer tests — exercise the per-repo single-pass contract:
 *   - One getPage(repo) call per indexRepo
 *   - SHA-anchored freshness via cache.getPage('__root__').commitSha
 *   - Single-flight collapses concurrent callers
 *   - v2.1: chunks AND KG edges written atomically in one transaction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { Embedder } from '../../src/adapters/embedder.js';
import { VectorStore } from '../../src/services/vector_store.js';
import { GraphStore } from '../../src/services/graph_store.js';
import { Indexer } from '../../src/services/indexer.js';
import type { CanonicalNode, ExtractionResult } from '../../src/extraction/canonical_tree.js';

const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const REACT_NODES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'overview', markdown: 'React overview. See [core](#core).' },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core module.' },
  { type: 'code', sectionSlug: 'core', language: 'ts', text: '// snippet', github: { repo: 'facebook/react', sha: SHA_A, path: 'src/x.ts' } },
];

function reactExtraction(sha = SHA_A): ExtractionResult {
  return { nodes: REACT_NODES, notFound: false, emptyShell: false, firstCommitSha: sha };
}

function notFoundExtraction(): ExtractionResult {
  return { nodes: [], notFound: true, emptyShell: false, firstCommitSha: null };
}

let tmpDir: string;
let cache: Cache;
let client: CodeWikiClient;
let store: VectorStore;
let graphStore: GraphStore;
let embedder: Embedder;
let encodeCallCount = 0;
let fetchCallCount = 0;

const DIM = 8;

const mockEncoder = {
  async encode(texts: string[]): Promise<Float32Array[]> {
    encodeCallCount += 1;
    return texts.map((t) => {
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-idx-'));
  // Force pure-JS for test fixtures using small DIM — the production
  // EMBED_MODEL_DIM=384 vec_chunks virtual table would reject these.
  process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
  cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
  client = new CodeWikiClient(new PlaywrightDriver(), cache);
  client.fetchPage = async (): Promise<ExtractionResult> => {
    fetchCallCount += 1;
    return reactExtraction(SHA_A);
  };
  store = new VectorStore(cache);
  graphStore = new GraphStore(cache);
  embedder = new Embedder({ modelDim: DIM, encoderImpl: mockEncoder });
  encodeCallCount = 0;
  fetchCallCount = 0;
});

afterEach(() => {
  cache.close();
  delete process.env.CODEWIKI_FORCE_PUREJS_VECTOR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Indexer — first call', () => {
  it('issues exactly ONE client.getPage and populates chunks', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    const result = await idx.indexRepo('facebook/react');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.chunkCount).toBeGreaterThan(0);
    }
    expect(fetchCallCount).toBe(1);
    expect(store.chunkCountForRepo('facebook/react')).toBeGreaterThan(0);
  });

  it('writes wiki_index_status with the cached page commit_sha', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react');
    const status = store.getWikiIndexStatus('facebook/react');
    expect(status).not.toBeNull();
    expect(status!.commitSha).toBe(SHA_A);
    expect(status!.chunkCount).toBeGreaterThan(0);
  });
});

describe('Indexer — freshness contract', () => {
  it('second call within TTL is a no-op (no embedder.encode call)', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react');
    const callsAfterFirst = encodeCallCount;
    const r2 = await idx.indexRepo('facebook/react');
    expect(r2.status).toBe('ready');
    expect(encodeCallCount).toBe(callsAfterFirst);
  });

  it('after TTL but with unchanged commit_sha, refreshes indexed_at only (no re-embed)', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react');
    const callsAfterFirst = encodeCallCount;
    const oldStatus = store.getWikiIndexStatus('facebook/react')!;
    store.upsertWikiIndexStatus('facebook/react', oldStatus.commitSha, oldStatus.chunkCount, oldStatus.edgeCount);
    const sqlStore = cache.getStore();
    sqlStore.prepare('UPDATE wiki_index_status SET indexed_at = ? WHERE repo = ?').run(0, 'facebook/react');
    const r2 = await idx.indexRepo('facebook/react');
    expect(r2.status).toBe('ready');
    expect(encodeCallCount).toBe(callsAfterFirst);
  });

  it('after TTL with changed commit_sha, re-runs full index', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react');
    const callsAfterFirst = encodeCallCount;

    const sqlStore = cache.getStore();
    sqlStore.prepare('UPDATE wiki_index_status SET indexed_at = ? WHERE repo = ?').run(0, 'facebook/react');
    client.fetchPage = async (): Promise<ExtractionResult> => {
      fetchCallCount += 1;
      return reactExtraction(SHA_B);
    };
    cache.invalidatePage('facebook/react', '__root__');

    const r2 = await idx.indexRepo('facebook/react');
    expect(r2.status).toBe('ready');
    expect(encodeCallCount).toBeGreaterThan(callsAfterFirst);
    const newStatus = store.getWikiIndexStatus('facebook/react');
    expect(newStatus!.commitSha).toBe(SHA_B);
  });
});

describe('Indexer — single-flight', () => {
  it('concurrent indexRepo calls for the same repo collapse into one build', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    const [a, b, c] = await Promise.all([
      idx.indexRepo('facebook/react'),
      idx.indexRepo('facebook/react'),
      idx.indexRepo('facebook/react'),
    ]);
    expect(a.status).toBe('ready');
    expect(b.status).toBe('ready');
    expect(c.status).toBe('ready');
    expect(encodeCallCount).toBe(1);
  });
});

describe('Indexer — failure modes', () => {
  it('propagates no_docs when client returns notFound', async () => {
    client.fetchPage = async (): Promise<ExtractionResult> => notFoundExtraction();
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    const r = await idx.indexRepo('this-org/never');
    expect(r.status).toBe('no_docs');
    expect(store.chunkCountForRepo('this-org/never')).toBe(0);
    expect(store.getWikiIndexStatus('this-org/never')).toBeNull();
  });

  it('PSF-004 layer 1: empty commitSha → status=retry with reason empty_commit_sha (no chunks written)', async () => {
    // Pre-Task-6 the indexer happily wrote chunks with an empty commit SHA;
    // those chunks would later trigger broken footers at serialize time.
    // Post-Task-6 it rejects upstream with a recoverable retry envelope.
    client.fetchPage = async (): Promise<ExtractionResult> => ({
      nodes: REACT_NODES,
      notFound: false,
      emptyShell: false,
      firstCommitSha: null,
    });
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    const r = await idx.indexRepo('empty-sha/repo');
    expect(r.status).toBe('retry');
    if (r.status === 'retry') {
      expect(r.reason).toMatch(/empty_commit_sha/);
      expect(r.retryAfterSeconds).toBe(60);
    }
    // No chunks should have been written.
    expect(store.chunkCountForRepo('empty-sha/repo')).toBe(0);
    expect(store.getWikiIndexStatus('empty-sha/repo')).toBeNull();
  });

  it('PSF-004 layer 1: malformed (non-hex) commitSha → status=retry', async () => {
    client.fetchPage = async (): Promise<ExtractionResult> => ({
      nodes: REACT_NODES,
      notFound: false,
      emptyShell: false,
      firstCommitSha: 'not-a-real-sha-just-text',
    });
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    const r = await idx.indexRepo('bad-sha/repo');
    expect(r.status).toBe('retry');
  });
});

// ---------------------------------------------------------------------------
// v2.1 KG additions
// ---------------------------------------------------------------------------

describe('Indexer — v2.1 graph build (default behavior)', () => {
  it('writes BOTH chunks AND kg_edges by default (one transaction)', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    const r = await idx.indexRepo('facebook/react');
    expect(r.status).toBe('ready');
    expect(store.chunkCountForRepo('facebook/react')).toBeGreaterThan(0);
    expect(graphStore.edgeCountForRepo('facebook/react')).toBeGreaterThan(0);
    if (r.status === 'ready') expect(r.edgeCount).toBeGreaterThan(0);
  });

  it('wiki_index_status.edge_count reflects the persisted edge count', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react');
    const status = store.getWikiIndexStatus('facebook/react');
    expect(status!.edgeCount).toBe(graphStore.edgeCountForRepo('facebook/react'));
  });

  it('different-SHA rebuild drops AND re-writes BOTH chunks and edges', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react');
    const initialEdges = graphStore.edgeCountForRepo('facebook/react');
    expect(initialEdges).toBeGreaterThan(0);

    // Expire status, change SHA, invalidate page cache.
    const sqlStore = cache.getStore();
    sqlStore.prepare('UPDATE wiki_index_status SET indexed_at = ? WHERE repo = ?').run(0, 'facebook/react');
    client.fetchPage = async (): Promise<ExtractionResult> => {
      // Different content — only one section + a code block, fewer edges.
      return {
        nodes: [
          { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
          { type: 'code', sectionSlug: 'core', language: 'ts', text: '// other', github: { repo: 'facebook/react', sha: SHA_B, path: 'src/y.ts' } },
        ],
        notFound: false,
        emptyShell: false,
        firstCommitSha: SHA_B,
      };
    };
    cache.invalidatePage('facebook/react', '__root__');

    await idx.indexRepo('facebook/react');
    const newStatus = store.getWikiIndexStatus('facebook/react');
    expect(newStatus!.commitSha).toBe(SHA_B);
    // The new tree has just one code_ref, no section_links → exactly 1 edge.
    expect(graphStore.edgeCountForRepo('facebook/react')).toBe(1);
  });

  it('same-SHA refresh path does NOT call extractEdges (edges not re-written)', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react');
    const initialEdges = graphStore.edgeCountForRepo('facebook/react');

    // Expire status, keep SHA.
    const sqlStore = cache.getStore();
    sqlStore.prepare('UPDATE wiki_index_status SET indexed_at = ? WHERE repo = ?').run(0, 'facebook/react');

    await idx.indexRepo('facebook/react');
    expect(graphStore.edgeCountForRepo('facebook/react')).toBe(initialEdges);
  });
});

describe('Indexer — v2.1 buildGraph: false (test seam)', () => {
  it('writes chunks but NOT kg_edges when buildGraph: false', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    const r = await idx.indexRepo('facebook/react', { buildGraph: false });
    expect(r.status).toBe('ready');
    if (r.status === 'ready') expect(r.edgeCount).toBeUndefined();
    expect(store.chunkCountForRepo('facebook/react')).toBeGreaterThan(0);
    expect(graphStore.edgeCountForRepo('facebook/react')).toBe(0);
    // wiki_index_status.edge_count is the -1 sentinel (graph never built)
    const status = store.getWikiIndexStatus('facebook/react');
    expect(status!.edgeCount).toBe(-1);
  });

  it('a default call AFTER a buildGraph:false call DOES populate kg_edges (lifecycle invariant)', async () => {
    const idx = new Indexer({ client, embedder, store, graphStore, cache });
    await idx.indexRepo('facebook/react', { buildGraph: false });
    expect(graphStore.edgeCountForRepo('facebook/react')).toBe(0);

    // Expire so the freshness branch doesn't short-circuit, but keep SHA.
    // (Defense-in-depth: even with fresh TTL, a default call should detect
    // edge_count=-1 and trigger the build.)
    await idx.indexRepo('facebook/react');
    expect(graphStore.edgeCountForRepo('facebook/react')).toBeGreaterThan(0);
    const status = store.getWikiIndexStatus('facebook/react');
    expect(status!.edgeCount).toBeGreaterThan(0);
  });
});
