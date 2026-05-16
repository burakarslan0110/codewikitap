/**
 * find_chunks integration test — drives the full MCP server surface via
 * InMemoryTransport, asserts the v2 contract:
 *   - top result is the core-hooks section for query 'hooks'
 *   - text matches CITATION_FOOTER_REGEX byte-for-byte
 *   - citation.sourceUrl ends with #core-hooks
 *   - citation.commitSha is the fixture's 40-char SHA
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';
import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { Embedder } from '../../src/adapters/embedder.js';
import { EMBED_MODEL_DIM } from '../../src/config_rag.js';
import { CITATION_FOOTER_REGEX } from '../../src/extraction/serializer.js';
import type { CanonicalNode, ExtractionResult } from '../../src/extraction/canonical_tree.js';

const SHA = 'd5736f098edee62c44f27b053e6e48f5fa443803';

const REACT_NODES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'overview', markdown: 'React overview text.' },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core module description.' },
  {
    type: 'code',
    sectionSlug: 'core',
    language: 'ts',
    text: "console.log('react')",
    github: { repo: 'facebook/react', sha: SHA, path: 'src/x.ts' },
  },
  { type: 'heading', sectionSlug: 'core-hooks', slug: 'core-hooks', title: 'Hooks', level: 3, parentSlug: 'core', hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core-hooks', markdown: 'useState, useEffect, etc.' },
];

// Align with production EMBED_MODEL_DIM so the cache's vec_chunks (created
// at the schema dim) accepts mock embeddings. v2.6 added a strict
// chunk-embedding-length check in vector_store.upsertChunks that rejects
// the pre-v2.6 DIM=8 fixture. Steering vectors below stay 8-position;
// vec() pads the rest with zeros, preserving cosine ranking.
const DIM = EMBED_MODEL_DIM;

// Mock encoder that returns DIFFERENT vectors per text content so cosine
// similarity ranking is deterministic without depending on randomness.
function vec(values: number[]): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < Math.min(values.length, DIM); i++) v[i] = values[i];
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}

const mockEncoder = {
  async encode(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      // Steer the section vectors so 'hooks' query maps to core-hooks.
      if (t.includes('useState')) return vec([0, 0, 1, 0, 0, 0, 0, 0]);
      if (t.includes('Core module')) return vec([0, 1, 0, 0, 0, 0, 0, 0]);
      if (t.includes('overview')) return vec([1, 0, 0, 0, 0, 0, 0, 0]);
      if (t === 'hooks') return vec([0, 0, 1, 0, 0, 0, 0, 0]);
      // Default unique-ish vector so non-matching chunks don't collide.
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

let tmpProjectDir: string;
let tmpCacheDir: string;
let cache: Cache;
let client: CodeWikiClient;
let mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
let mcpClient: Client;

beforeEach(async () => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-fc-int-proj-'));
  tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-fc-int-cache-'));

  fs.writeFileSync(
    path.join(tmpProjectDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.1', dependencies: { react: '^19.0.0' } }),
  );

  cache = await Cache.open({ dbPath: path.join(tmpCacheDir, 'cache.db') });
  client = new CodeWikiClient(new PlaywrightDriver(), cache);
  client.fetchPage = async (): Promise<ExtractionResult> => ({
    nodes: REACT_NODES,
    notFound: false,
    emptyShell: false,
    firstCommitSha: SHA,
  });
  cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');

  const embedder = new Embedder({ modelDim: DIM, encoderImpl: mockEncoder });
  const built = await buildServer({ cwd: tmpProjectDir, cache, client, embedder });
  mcpServer = built.server;

  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  mcpClient = new Client({ name: 'test-client', version: '0.0.1' });
  await mcpClient.connect(clientT);
});

afterEach(async () => {
  try { await mcpClient.close(); } catch { /* ignore */ }
  try { await mcpServer.close(); } catch { /* ignore */ }
  cache.close();
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  fs.rmSync(tmpCacheDir, { recursive: true, force: true });
});

interface FindChunksResponse {
  query: string;
  repo: string | null;
  chunks: Array<{
    sectionSlug: string;
    text: string;
    citation: { sourceUrl: string; commitSha: string };
  }>;
  status?: string;
}

function structuredOf<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

describe('find_chunks integration — happy path', () => {
  it('returns core-hooks as the top chunk for query "hooks"', async () => {
    const r = await mcpClient.callTool({
      name: 'find_chunks',
      arguments: { query: 'hooks', repo: 'facebook/react', k: 3 },
    });
    const s = structuredOf<FindChunksResponse>(r);
    expect(s.chunks.length).toBeGreaterThan(0);
    expect(s.chunks[0].sectionSlug).toBe('core-hooks');
  });

  it("each returned chunk's text matches CITATION_FOOTER_REGEX byte-for-byte", async () => {
    const r = await mcpClient.callTool({
      name: 'find_chunks',
      arguments: { query: 'hooks', repo: 'facebook/react', k: 3 },
    });
    const s = structuredOf<FindChunksResponse>(r);
    for (const c of s.chunks) {
      expect(CITATION_FOOTER_REGEX.test(c.text)).toBe(true);
    }
  });

  it("top chunk's citation.sourceUrl ends with #core-hooks and commitSha matches the fixture SHA", async () => {
    const r = await mcpClient.callTool({
      name: 'find_chunks',
      arguments: { query: 'hooks', repo: 'facebook/react', k: 1 },
    });
    const s = structuredOf<FindChunksResponse>(r);
    expect(s.chunks[0].citation.sourceUrl.endsWith('#core-hooks')).toBe(true);
    expect(s.chunks[0].citation.commitSha).toBe(SHA);
  });
});

describe('find_chunks integration — tool surface lock', () => {
  it('the 5-tool surface is registered and find_chunks is callable via MCP', async () => {
    // v0.7: surface dropped to 5 names. request_indexing folded into
    // get_page({ prepareOnly: true }); list_pages still exposed via
    // get_page({ listPages: true }).
    const tools = await mcpClient.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'find_chunks',
      'find_neighbors',
      'get_page',
      'list_project_dependencies',
      'resolve_repo',
    ]);
  });
});
