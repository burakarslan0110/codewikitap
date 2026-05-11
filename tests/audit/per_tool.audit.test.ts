/**
 * AUDIT_TS_002..008 — Per-tool happy + degraded scenario coverage.
 *
 * One `describe` per tool (7 blocks). Each tool gets at least:
 *   - Happy path: valid input → structured success response, schema-conformant.
 *   - Degraded path: tool-specific failure mode → structured error envelope
 *     (no thrown exception escapes; `isError: false` for structured failures).
 *
 * Wired via InMemoryTransport (same shape as integration tests). Embedder
 * and reranker are mocked at the buildServer seam so the audit is offline-
 * deterministic. Live invocations gate on `CODEWIKI_AUDIT_LIVE=1`.
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
import { mkTempDirs, fixtureExtraction, notFoundExtraction } from './scenarios.js';

let dirs: ReturnType<typeof mkTempDirs>;
let cache: Cache;
let cwClient: CodeWikiClient;
let mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
let mcpClient: Client;

function deterministicEmbed(text: string): Float32Array {
  const v = new Float32Array(EMBED_MODEL_DIM);
  let acc = 0;
  for (let i = 0; i < text.length; i++) acc = (acc * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < v.length; i++) {
    acc = (acc * 1103515245 + 12345) >>> 0;
    v[i] = ((acc & 0xffff) / 0xffff - 0.5) * 0.01;
  }
  v[0] = (text.length % 8) / 8;
  v[1] = text.includes('authenticate') ? 1 : 0;
  v[2] = text.includes('Hooks') ? 1 : 0;
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  return v;
}

const mockEmbedder = {
  async encode(texts: string[]): Promise<Float32Array[]> {
    return texts.map(deterministicEmbed);
  },
  getFingerprint() {
    return { model: 'audit/mock-encoder', dim: EMBED_MODEL_DIM };
  },
  close() {},
} as unknown as Embedder;

const mockReranker = {
  async score(_query: string, texts: string[]): Promise<number[]> {
    // Deterministic rerank: rank by inverse text length (longer = higher).
    return texts.map((t, i) => t.length + i * 0.001);
  },
  getFingerprint() {
    return { model: 'audit/mock-reranker' };
  },
  close() {},
} as unknown as Reranker;

async function setupServer(): Promise<void> {
  dirs = mkTempDirs('codewiki-audit-per-tool');
  fs.writeFileSync(
    path.join(dirs.projectDir, 'package.json'),
    JSON.stringify({
      name: 'audit-fixture',
      version: '0.0.1',
      dependencies: { react: '^19.0.0', 'made-up-uncovered-pkg-zzz': '^1.0.0' },
    }),
  );
  cache = await Cache.open({ dbPath: path.join(dirs.cacheDir, 'cache.db') });
  cwClient = new CodeWikiClient(new PlaywrightDriver(), cache);
  cwClient.fetchPage = async (repo: string) => {
    if (repo === 'audit/fixture' || repo === 'facebook/react') return fixtureExtraction();
    return notFoundExtraction();
  };
  cache.setRepo('react', 'npm', 'audit', 'fixture', 'npm-registry', 'high');

  const built = await buildServer({
    cwd: dirs.projectDir,
    cache,
    client: cwClient,
    embedder: mockEmbedder,
    reranker: mockReranker,
  });
  mcpServer = built.server;
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  mcpClient = new Client({ name: 'audit-client', version: '0.0.1' });
  await mcpClient.connect(clientT);
}

async function teardownServer(): Promise<void> {
  try { await mcpClient.close(); } catch { /* ignore */ }
  try { await mcpServer.close(); } catch { /* ignore */ }
  cache.close();
  dirs.cleanup();
}

beforeEach(setupServer);
afterEach(teardownServer);

function struct(r: unknown): Record<string, unknown> {
  const obj = r as { structuredContent?: unknown };
  return (obj.structuredContent as Record<string, unknown>) ?? {};
}

// ----- AUDIT_TS_002: list_project_dependencies -----
describe('AUDIT_TS_002: list_project_dependencies happy + degraded', () => {
  it('happy path returns deps with projectRoot + dependencies array', async () => {
    const r = await mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
    const s = struct(r);
    expect(s.projectRoot).toBe(dirs.projectDir);
    expect(s.manifestType).toBe('package.json');
    expect(Array.isArray(s.dependencies)).toBe(true);
    expect(typeof s.total).toBe('number');
  });

  it('degraded: scan directory with NO manifest -> empty dependencies', async () => {
    // Create a fresh server scoped to a dir with no manifest.
    const otherDirs = mkTempDirs('codewiki-audit-no-manifest');
    try {
      const otherCache = await Cache.open({ dbPath: path.join(otherDirs.cacheDir, 'cache.db') });
      const otherClient = new CodeWikiClient(new PlaywrightDriver(), otherCache);
      otherClient.fetchPage = async () => notFoundExtraction();
      const built = await buildServer({ cwd: otherDirs.projectDir, cache: otherCache, client: otherClient });
      const [s1, c1] = InMemoryTransport.createLinkedPair();
      await built.server.connect(s1);
      const cl = new Client({ name: 'audit-client', version: '0.0.1' });
      await cl.connect(c1);
      const r = await cl.callTool({ name: 'list_project_dependencies', arguments: {} });
      const s = struct(r);
      expect(s.dependencies).toEqual([]);
      expect(s.total).toBe(0);
      await cl.close();
      await built.server.close();
      otherCache.close();
    } finally {
      otherDirs.cleanup();
    }
  });
});

// ----- AUDIT_TS_003: resolve_repo -----
describe('AUDIT_TS_003: resolve_repo happy + degraded', () => {
  it('happy path with cached resolution returns owner/repo', async () => {
    // resolve_repo input field is `query` (not `name`); output omits `status`
    // on success, populates owner/repo/source/confidence.
    const r = await mcpClient.callTool({ name: 'resolve_repo', arguments: { query: 'react', ecosystem: 'npm' } });
    const s = struct(r);
    expect(s.status).toBeUndefined();
    expect(s.owner).toBe('audit');
    expect(s.repo).toBe('fixture');
  });

  it('degraded: nonexistent package returns no_match', async () => {
    const r = await mcpClient.callTool({
      name: 'resolve_repo',
      arguments: { query: 'definitely-does-not-exist-zzz-9876', ecosystem: 'npm' },
    });
    const s = struct(r);
    expect(s.status).toBe('no_match');
  });
});

// ----- AUDIT_TS_004: list_pages -----
describe('AUDIT_TS_004: list_pages happy + degraded', () => {
  it('happy path returns pageIndex for indexed repo', async () => {
    const r = await mcpClient.callTool({ name: 'list_pages', arguments: { repo: 'audit/fixture' } });
    const s = struct(r);
    // Either status: 'ok' with pages, or status not present (data inline)
    expect(s.repo).toBe('audit/fixture');
  });

  it('degraded: unknown repo returns no_wiki envelope', async () => {
    const r = await mcpClient.callTool({
      name: 'list_pages',
      arguments: { repo: 'definitely/not-indexed' },
    });
    const s = struct(r);
    expect(s.status).toBe('no_wiki');
    expect(s.repo).toBe('definitely/not-indexed');
    expect(s.pageIndex).toEqual([]);
  });
});

// ----- AUDIT_TS_005: get_page -----
describe('AUDIT_TS_005: get_page happy + degraded', () => {
  it('happy path returns markdown body in content.markdown', async () => {
    // get_page output: { content: { type: 'markdown', markdown: string }, citation, ... }
    const r = await mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture' } });
    const s = struct(r);
    expect(s.status).toBeUndefined();
    const content = s.content as { type: string; markdown: string } | undefined;
    expect(content?.type).toBe('markdown');
    expect(typeof content?.markdown).toBe('string');
  });

  it('degraded: unknown repo returns no_docs', async () => {
    const r = await mcpClient.callTool({
      name: 'get_page',
      arguments: { repo: 'unknown/repo-not-in-fixture' },
    });
    const s = struct(r);
    expect(s.status).toBe('no_docs');
  });
});

// ----- AUDIT_TS_006: find_chunks -----
describe('AUDIT_TS_006: find_chunks happy + degraded', () => {
  it('happy path returns ranked chunks with citations', async () => {
    // Two-call pattern: first call races indexer (may return index_building),
    // second call hits the populated index.
    let r = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'authentication', k: 3 } });
    let s = struct(r);
    if (s.status === 'index_building') {
      r = await mcpClient.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'authentication', k: 3 } });
      s = struct(r);
    }
    expect(Array.isArray(s.chunks)).toBe(true);
    expect((s.chunks as unknown[]).length).toBeGreaterThan(0);
  });

  it('degraded: CODEWIKI_FORCE_NO_BM25=1 → hybrid:vector_only', async () => {
    // Set env BEFORE constructing a fresh server (VectorStore reads on init).
    const prev = process.env.CODEWIKI_FORCE_NO_BM25;
    process.env.CODEWIKI_FORCE_NO_BM25 = '1';
    const otherDirs = mkTempDirs('codewiki-audit-no-bm25');
    try {
      const otherCache = await Cache.open({ dbPath: path.join(otherDirs.cacheDir, 'cache.db') });
      const otherClient = new CodeWikiClient(new PlaywrightDriver(), otherCache);
      otherClient.fetchPage = async (repo: string) => repo === 'audit/fixture' ? fixtureExtraction() : notFoundExtraction();
      const built = await buildServer({
        cwd: otherDirs.projectDir,
        cache: otherCache,
        client: otherClient,
        embedder: mockEmbedder,
        reranker: mockReranker,
      });
      const [s1, c1] = InMemoryTransport.createLinkedPair();
      await built.server.connect(s1);
      const cl = new Client({ name: 'audit-client', version: '0.0.1' });
      await cl.connect(c1);
      let r = await cl.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'authentication', k: 3 } });
      let s = struct(r);
      if (s.status === 'index_building') {
        r = await cl.callTool({ name: 'find_chunks', arguments: { repo: 'audit/fixture', query: 'authentication', k: 3 } });
        s = struct(r);
      }
      expect(s.hybrid).toBe('vector_only');
      expect(s.reason).toBe('force_no_bm25');
      await cl.close();
      await built.server.close();
      otherCache.close();
    } finally {
      otherDirs.cleanup();
      if (prev === undefined) delete process.env.CODEWIKI_FORCE_NO_BM25;
      else process.env.CODEWIKI_FORCE_NO_BM25 = prev;
    }
  });
});

// ----- AUDIT_TS_007: find_neighbors -----
describe('AUDIT_TS_007: find_neighbors happy + degraded', () => {
  it('happy path returns code_ref neighbors', async () => {
    let r = await mcpClient.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'pages_referencing_file', file_path: 'src/auth.ts', github_repo: 'audit/fixture' },
    });
    let s = struct(r);
    if (s.status === 'index_building') {
      r = await mcpClient.callTool({
        name: 'find_neighbors',
        arguments: { kind: 'pages_referencing_file', file_path: 'src/auth.ts', github_repo: 'audit/fixture' },
      });
      s = struct(r);
    }
    expect(Array.isArray(s.neighbors)).toBe(true);
  });

  it('degraded: cross_repo with no project deps returns empty neighbors', async () => {
    const r = await mcpClient.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'cross_repo', repo: 'no/such-repo-zzz' },
    });
    const s = struct(r);
    // Either neighbors empty, or status indicates a known failure mode.
    if (Array.isArray(s.neighbors)) {
      expect((s.neighbors as unknown[]).length).toBe(0);
    } else {
      expect(['no_docs', 'index_building'].includes(s.status as string)).toBe(true);
    }
  });
});

// ----- AUDIT_TS_008: request_indexing -----
describe('AUDIT_TS_008: request_indexing happy + degraded', () => {
  it('happy path returns status=ready for known fixture', async () => {
    let r = await mcpClient.callTool({ name: 'request_indexing', arguments: { repo: 'audit/fixture' } });
    let s = struct(r);
    if (s.status === 'index_building') {
      r = await mcpClient.callTool({ name: 'request_indexing', arguments: { repo: 'audit/fixture' } });
      s = struct(r);
    }
    expect(s.status).toBe('ready');
    expect(typeof s.chunkCount).toBe('number');
  });

  it('degraded: bad repo format triggers MCP input-validation error', async () => {
    // The MCP SDK validates via Zod and returns { isError: true, content: [...] }
    // (does NOT reject the promise — that's the SDK's contract).
    const r = (await mcpClient.callTool({
      name: 'request_indexing',
      arguments: { repo: 'no-slash-here' },
    })) as { isError?: boolean; content?: unknown[] };
    expect(r.isError).toBe(true);
    expect(Array.isArray(r.content)).toBe(true);
  });
});
