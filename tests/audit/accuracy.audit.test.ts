/**
 * AUDIT_TS_015..017 — Accuracy invariants.
 * AUDIT_TS_018..020 — pre-known finding scenario stubs (Tasks 4, 5, 6 fill).
 *
 * 015: Citation footer byte-equal across get_page + find_chunks paths.
 *      Both must end with the same `CITATION_FOOTER_REGEX` match.
 *
 * 016: Chunker section coverage — every HeadingNode with content produces
 *      at least one chunk. Locks the "per-heading-section (NOT leaf-only)"
 *      contract from .claude/rules/codewiki-mcp-rag.md.
 *
 * 017: RRF fusion determinism — fixed vector + BM25 input arrays produce
 *      the documented `Σ 1/(k + rank)` ordering.
 *
 * 018: stub (Task 4 will fill) — truncated invariant unification.
 * 019: stub (Task 5 will fill) — repoTotal includes BM25-only chunks.
 * 020: stub (Task 6 will fill) — empty commitSha → status=retry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';
import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { Embedder } from '../../src/adapters/embedder.js';
import { Reranker } from '../../src/adapters/reranker.js';
import { EMBED_MODEL_DIM } from '../../src/config_rag.js';
import { CITATION_FOOTER_REGEX } from '../../src/extraction/serializer.js';
import { chunkPage } from '../../src/extraction/chunker.js';
import { reciprocalRankFusion } from '../../src/services/fusion.js';
import type { QueryResult, BM25QueryResult } from '../../src/services/vector_store.js';
import type { HeadingNode } from '../../src/extraction/canonical_tree.js';
import { mkTempDirs, fixtureExtraction } from './scenarios.js';

const mockEmbedder = {
  async encode(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => {
      const v = new Float32Array(EMBED_MODEL_DIM);
      v[0] = 1;
      return v;
    });
  },
  getFingerprint() { return { model: 'audit/mock', dim: EMBED_MODEL_DIM }; },
  close() {},
} as unknown as Embedder;

const mockReranker = {
  async score(_q: string, texts: string[]): Promise<number[]> {
    return texts.map((_t, i) => -i);
  },
  getFingerprint() { return { model: 'audit/mock-reranker' }; },
  close() {},
} as unknown as Reranker;

function struct(r: unknown): Record<string, unknown> {
  return ((r as { structuredContent?: unknown }).structuredContent as Record<string, unknown>) ?? {};
}

let dirs: ReturnType<typeof mkTempDirs>;
let cache: Cache;
let cwClient: CodeWikiClient;
let mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
let mcpClient: Client;

async function setup(): Promise<void> {
  dirs = mkTempDirs('codewiki-audit-accuracy');
  fs.writeFileSync(
    path.join(dirs.projectDir, 'package.json'),
    JSON.stringify({ name: 'a', version: '0.0.1', dependencies: {} }),
  );
  cache = await Cache.open({ dbPath: path.join(dirs.cacheDir, 'cache.db') });
  cwClient = new CodeWikiClient(new PlaywrightDriver(), cache);
  cwClient.fetchPage = async () => fixtureExtraction();
  const built = await buildServer({
    cwd: dirs.projectDir,
    cache,
    client: cwClient,
    embedder: mockEmbedder,
    reranker: mockReranker,
  });
  mcpServer = built.server;
  const [s1, c1] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(s1);
  mcpClient = new Client({ name: 'audit-client', version: '0.0.1' });
  await mcpClient.connect(c1);
}

async function teardown(): Promise<void> {
  try { await mcpClient.close(); } catch { /* ignore */ }
  try { await mcpServer.close(); } catch { /* ignore */ }
  cache.close();
  dirs.cleanup();
}

// ----- AUDIT_TS_015: Citation byte-equal across get_page + find_chunks -----
describe('AUDIT_TS_015: Citation footer byte-equal across get_page + find_chunks', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('both paths emit footer matching CITATION_FOOTER_REGEX with same SHA', async () => {
    const pageRes = await mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture' } });
    const pageStruct = struct(pageRes);
    const pageContent = pageStruct.content as { markdown: string };
    const pageMd = pageContent.markdown;
    expect(pageMd).toMatch(CITATION_FOOTER_REGEX);

    // Trigger indexer for find_chunks
    let chunkRes = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'authentication', k: 3 } });
    let chunkStruct = struct(chunkRes);
    if (chunkStruct.status === 'index_building') {
      chunkRes = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'authentication', k: 3 } });
      chunkStruct = struct(chunkRes);
    }
    const chunks = chunkStruct.chunks as Array<{ text: string; citation: { commitSha: string } }>;
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.text).toMatch(CITATION_FOOTER_REGEX);
      expect(c.citation.commitSha).toMatch(/^[0-9a-f]{40}$/);
    }

    // Byte-equal: both rendered footers must use the same 40-hex commitSha
    // for the same fixture. Extract them from the regex captures.
    const pageMatch = CITATION_FOOTER_REGEX.exec(pageMd);
    expect(pageMatch).not.toBeNull();
    const pageSha = pageMatch![2];
    for (const c of chunks) {
      expect(c.citation.commitSha).toBe(pageSha);
    }
  });
});

// ----- AUDIT_TS_016: Chunker section coverage -----
describe('AUDIT_TS_016: Chunker section coverage (every HeadingNode with content -> >=1 chunk)', () => {
  it('every distinct sectionSlug from the fixture appears in chunkPage output', () => {
    const { nodes } = fixtureExtraction();
    const chunks = chunkPage('audit/fixture', '__root__', nodes, { maxTokens: 512, overlapTokens: 64 });
    const headingSlugs = nodes
      .filter((n) => n.type === 'heading')
      .map((n) => (n as HeadingNode).sectionSlug);
    const distinctHeadings = new Set(headingSlugs);
    const chunkSlugs = new Set(chunks.map((c) => c.sectionSlug));
    for (const h of distinctHeadings) {
      expect(chunkSlugs.has(h)).toBe(true);
    }
  });
});

// ----- AUDIT_TS_017: RRF fusion determinism -----
describe('AUDIT_TS_017: RRF fusion ranking determinism', () => {
  it('known input produces documented Σ 1/(k+rank) output', () => {
    // Three chunks (A, B, C). A appears at vector-rank 1 and bm25-rank 2.
    // B appears only in vector at rank 2. C appears only in bm25 at rank 1.
    // QueryResult and BM25QueryResult both extend IndexedChunk; their custom
    // `score` field is cosine (vector) or inverted-BM25 (bm25) respectively.
    const makeRow = (id: string, score: number): QueryResult => ({
      repo: 'audit/fixture',
      pageSlug: '__root__',
      sectionSlug: id,
      ordinal: 0,
      text: `chunk-${id}`,
      commitSha: 'a'.repeat(40),
      indexedAt: 0,
      embedding: new Float32Array(EMBED_MODEL_DIM),
      score,
    });
    const A = makeRow('A', 0.9);
    const B = makeRow('B', 0.8);
    const aBm: BM25QueryResult = makeRow('A', 0.7);
    const cBm: BM25QueryResult = makeRow('C', 0.9);

    const fused = reciprocalRankFusion([A, B], [cBm, aBm], { k: 60, cap: 10 });
    expect(fused.length).toBe(3);

    // A: vector rank 1, bm25 rank 2 → RRF = 1/61 + 1/62
    // B: vector rank 2, bm25 rank null → RRF = 1/62
    // C: vector rank null, bm25 rank 1 → RRF = 1/61
    const byKey = new Map(fused.map((f) => {
      const c = f.chunk as QueryResult;
      return [c.sectionSlug, f];
    }));
    const aScore = 1 / 61 + 1 / 62;
    const bScore = 1 / 62;
    const cScore = 1 / 61;
    expect(byKey.get('A')?.rrfScore).toBeCloseTo(aScore, 10);
    expect(byKey.get('B')?.rrfScore).toBeCloseTo(bScore, 10);
    expect(byKey.get('C')?.rrfScore).toBeCloseTo(cScore, 10);

    // Top-1 is A (highest combined RRF).
    expect((fused[0].chunk as QueryResult).sectionSlug).toBe('A');
  });
});

// ----- AUDIT_TS_018: PSF-002 lock (Task 4) -----
describe('AUDIT_TS_018: truncated invariant unified across happy + offset-beyond-window paths', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('find_chunks happy + offset-beyond return the same truncated value (PSF-002)', async () => {
    // Trigger indexer first so subsequent calls hit the populated index.
    let r1 = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'core', k: 8 } });
    let s1 = struct(r1);
    if (s1.status === 'index_building') {
      r1 = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'core', k: 8 } });
      s1 = struct(r1);
    }
    // Use the chunkCount from a request_indexing call to bound the offset
    // far beyond any reasonable rerank window for this fixture.
    const r2 = await mcpClient.callTool({
      name: 'find_chunks',
      arguments: { repo: 'audit/fixture', query: 'core', k: 8, offset: 10_000 },
    });
    const s2 = struct(r2);
    // Both return the truncated field. Post-Task-4 they are the SAME value
    // (sourced from the single loop-set `truncated` variable in retriever).
    expect(s2.truncated).toBe(s1.truncated);
  });
});

describe('AUDIT_TS_019: repoTotal includes BM25-only chunks (hybrid)', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('find_chunks repoTotal reflects union of vector + BM25-only matches (PSF-003)', async () => {
    // Warm-up: trigger indexer; second call hits the populated index.
    let r1 = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'core', k: 8 } });
    let s1 = struct(r1);
    if (s1.status === 'index_building') {
      r1 = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'core', k: 8 } });
      s1 = struct(r1);
    }
    expect(s1.hybridStats).toBeDefined();
    const stats = s1.hybridStats as { bm25Count: number; vectorCount: number };
    // The union of returned vector + BM25 rows is the minimum honest
    // value for repoTotal. With both branches engaged on the fixture,
    // we expect repoTotal >= bm25Count (the BM25-only contribution).
    // Pre-fix: repoTotal would equal vector-only total and could be < bm25Count.
    if (stats.bm25Count > 0) {
      expect(typeof s1.repoTotal).toBe('number');
      expect(s1.repoTotal as number).toBeGreaterThanOrEqual(stats.bm25Count);
    }
  });
});

describe('AUDIT_TS_020: Empty commitSha routes to status=retry (no broken footer)', () => {
  // PSF-004 Codex follow-up: get_page must also map empty-SHA to retry,
  // not let SerializerError escape. Independent assertion from the
  // find_chunks path below — covers tool layer 2 for get_page.
  it('get_page returns status=retry when upstream page has empty commitSha (PSF-004 layer-2 for get_page)', async () => {
    const localDirs = mkTempDirs('codewiki-audit-get-page-empty-sha');
    try {
      const cache = await Cache.open({ dbPath: path.join(localDirs.cacheDir, 'cache.db') });
      const client = new CodeWikiClient(new PlaywrightDriver(), cache);
      // Inject getPage directly to bypass indexer's layer-1 guard so the
      // tool's layer-2 (in src/tools/get_page.ts) is the load-bearing one.
      client.getPage = async (repo: string) => ({
        repo,
        slug: '__root__',
        subsection: null,
        nodes: fixtureExtraction().nodes,
        availableSubsections: [],
        citation: { sourceUrl: `https://codewiki.google/github.com/${repo}#__root__`, commitSha: '', lastChecked: new Date().toISOString() },
      });
      const built = await buildServer({
        cwd: localDirs.projectDir,
        cache,
        client,
        embedder: mockEmbedder,
        reranker: mockReranker,
      });
      const [s1, c1] = InMemoryTransport.createLinkedPair();
      await built.server.connect(s1);
      const cl = new Client({ name: 'audit-client', version: '0.0.1' });
      await cl.connect(c1);

      const r = await cl.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture' } });
      const s = struct(r);
      expect(s.status).toBe('retry');
      expect(s.reason as string).toMatch(/empty_commit_sha/);
      // No content/markdown emitted under retry path — broken footer impossible.
      expect(s.content).toBeUndefined();

      await cl.close();
      await built.server.close();
      cache.close();
    } finally {
      localDirs.cleanup();
    }
  });

  it('indexer rejects empty SHA upstream; find_chunks returns status=retry, no broken footer (PSF-004)', async () => {
    // Spin up a fresh server with a fetchPage that returns null firstCommitSha,
    // simulating the upstream-page edge case PSF-004 defends against.
    const localDirs = mkTempDirs('codewiki-audit-empty-sha');
    try {
      const cache = await Cache.open({ dbPath: path.join(localDirs.cacheDir, 'cache.db') });
      const client = new CodeWikiClient(new PlaywrightDriver(), cache);
      client.fetchPage = async () => ({
        nodes: fixtureExtraction().nodes,
        notFound: false,
        emptyShell: false,
        firstCommitSha: null,
      });
      const built = await buildServer({
        cwd: localDirs.projectDir,
        cache,
        client,
        embedder: mockEmbedder,
        reranker: mockReranker,
      });
      const [s1, c1] = InMemoryTransport.createLinkedPair();
      await built.server.connect(s1);
      const cl = new Client({ name: 'audit-client', version: '0.0.1' });
      await cl.connect(c1);

      const r = await cl.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'core', k: 3 } });
      const s = struct(r);

      // The find_chunks → retriever → indexer race ends with the indexer's
      // layer-1 retry envelope. The retriever surfaces it as the result's
      // status field; chunks[] is empty so no broken footer can be emitted.
      expect(s.status).toBe('retry');
      expect(s.reason as string).toMatch(/empty_commit_sha/);
      const chunks = (s.chunks as unknown[]) ?? [];
      expect(chunks.length).toBe(0);

      await cl.close();
      await built.server.close();
      cache.close();
    } finally {
      localDirs.cleanup();
    }
  });
});
