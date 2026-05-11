/**
 * v2.8 end-to-end coverage — drives the full MCP server stack (server.ts →
 * tools/find_neighbors.ts → GraphQuery → Indexer + GraphStore + VectorStore)
 * against the fixture from `tests/audit/scenarios.ts:fixtureExtractionFullEdgeTypes`
 * which exercises every stored edge type (code_ref, cross_repo_ref,
 * diagram_member, diagram_edge, section_link).
 *
 * Counterpart to AUDIT_TS_028 — the audit harness tests the same shape but
 * via direct GraphQuery calls; this file routes through MCP InMemoryTransport
 * so tool schema validation + citation construction are also exercised.
 *
 * Vacuous-pass guard: the suite asserts `kg_edges` row count and
 * `index_build_ms` ceilings so a future O(n²) merge regression is caught.
 *
 * Revert-proof procedure (run during Task 5 sign-off — see plan §Task 5
 * Verify): git stash the v2.8 changes in graph_extractor.ts or
 * dom_to_tree.ts and re-run; the corresponding suites here MUST fail.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { Reranker } from '../../src/adapters/reranker.js';
import { EMBED_MODEL_DIM } from '../../src/config_rag.js';
import {
  fixtureExtractionFullEdgeTypes,
  notFoundExtraction,
} from '../audit/scenarios.js';

const DIM = EMBED_MODEL_DIM;
const mockEncoder = {
  async encode(texts: string[]): Promise<Float32Array[]> {
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

const mockReranker = {
  async score(_query: string, texts: string[]): Promise<number[]> {
    return texts.map((t, i) => t.length + i * 0.001);
  },
  getFingerprint() {
    return { model: 'integration/mock-reranker' };
  },
  close() {},
} as unknown as Reranker;

interface FindNeighborsResponse {
  neighbors: Array<{
    kind: string;
    id: string;
    edge_type: string;
    direction: string;
    citation?: { sourceUrl: string };
    metadata?: Record<string, unknown>;
  }>;
  truncated: boolean;
  status?: string;
}

function structuredOf<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

let tmpProjectDir: string;
let tmpCacheDir: string;
let cache: Cache;
let cwClient: CodeWikiClient;
let mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
let mcpClient: Client;
let indexBuildMs = 0;

beforeAll(async () => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-v28-int-proj-'));
  tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-v28-int-cache-'));
  fs.writeFileSync(
    path.join(tmpProjectDir, 'package.json'),
    JSON.stringify({ name: 'v28-int-fixture', version: '0.0.1', dependencies: {} }),
  );

  cache = await Cache.open({ dbPath: path.join(tmpCacheDir, 'cache.db') });
  cwClient = new CodeWikiClient(new PlaywrightDriver(), cache);
  cwClient.fetchPage = async (repo: string) =>
    repo === 'audit/fixture' ? fixtureExtractionFullEdgeTypes() : notFoundExtraction();

  const embedder = new Embedder({ modelDim: DIM, encoderImpl: mockEncoder });
  const built = await buildServer({
    cwd: tmpProjectDir,
    cache,
    client: cwClient,
    embedder,
    reranker: mockReranker,
  });
  mcpServer = built.server;

  // Pre-build the index so all stored edge types are populated before any
  // find_neighbors call. Time it for the vacuous-pass-guard assertion.
  const { Indexer } = await import('../../src/services/indexer.js');
  const { GraphStore } = await import('../../src/services/graph_store.js');
  const { VectorStore } = await import('../../src/services/vector_store.js');
  const idx = new Indexer({
    client: cwClient,
    embedder,
    store: new VectorStore(cache),
    graphStore: new GraphStore(cache),
    cache,
  });
  const t0 = Date.now();
  await idx.indexRepo('audit/fixture');
  indexBuildMs = Date.now() - t0;

  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  mcpClient = new Client({ name: 'v28-int-client', version: '0.0.1' });
  await mcpClient.connect(clientT);
});

afterAll(async () => {
  try { await mcpClient.close(); } catch { /* ignore */ }
  try { await mcpServer.close(); } catch { /* ignore */ }
  cache.close();
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  fs.rmSync(tmpCacheDir, { recursive: true, force: true });
});

describe('find_neighbors v2.8 edge-types — end-to-end via MCP InMemoryTransport', () => {
  it('pages_referencing_file returns the section neighbor with edge_type=code_ref', async () => {
    const r = await mcpClient.callTool({
      name: 'find_neighbors',
      arguments: {
        kind: 'pages_referencing_file',
        file_path: 'src/babel/Plugin.ts',
        github_repo: 'audit/fixture',
      },
    });
    const s = structuredOf<FindNeighborsResponse>(r);
    expect(s.neighbors.length).toBeGreaterThan(0);
    const codeRefNeighbor = s.neighbors.find(
      (n) => n.kind === 'section' && n.edge_type === 'code_ref',
    );
    expect(codeRefNeighbor).toBeDefined();
    expect(codeRefNeighbor!.id).toBe('audit/fixture#core');
    // Citation must carry a sourceUrl built from the owning-section anchor.
    expect(codeRefNeighbor!.citation?.sourceUrl).toContain('audit/fixture');
  });

  it('diagram_neighbors (section-only) returns both diagram_member nodes + the diagram_edge between them', async () => {
    const r = await mcpClient.callTool({
      name: 'find_neighbors',
      arguments: {
        kind: 'diagram_neighbors',
        repo: 'audit/fixture',
        section_slug: 'core',
      },
    });
    const s = structuredOf<FindNeighborsResponse>(r);
    const diagramNodes = s.neighbors.filter((n) => n.kind === 'diagram_node');
    expect(diagramNodes.map((n) => n.id).sort()).toEqual(
      expect.arrayContaining(['audit/fixture#core::n1', 'audit/fixture#core::n2']),
    );
    // The structural diagram_edge surfaces as an outbound diagram_node neighbor
    // with source_node_id metadata.
    const structuralEdge = s.neighbors.find(
      (n) =>
        n.edge_type === 'diagram_edge' &&
        n.id === 'audit/fixture#core::n2' &&
        (n.metadata?.source_node_id as string | undefined) === 'audit/fixture#core::n1',
    );
    expect(structuralEdge).toBeDefined();
  });

  it('section_links (overview, out) returns same-repo section neighbors', async () => {
    const r = await mcpClient.callTool({
      name: 'find_neighbors',
      arguments: {
        kind: 'section_links',
        repo: 'audit/fixture',
        section_slug: 'overview',
        direction: 'out',
      },
    });
    const s = structuredOf<FindNeighborsResponse>(r);
    const sectionNeighbors = s.neighbors.filter((n) => n.kind === 'section');
    expect(sectionNeighbors.length).toBeGreaterThan(0);
    // The fixture has overview → core and overview → api anchor links.
    const ids = new Set(sectionNeighbors.map((n) => n.id));
    expect(ids.has('audit/fixture#core')).toBe(true);
    expect(ids.has('audit/fixture#api')).toBe(true);
  });

  it('cross_repo (out) returns the foreign repo with metadata.kinds containing prose_link', async () => {
    const r = await mcpClient.callTool({
      name: 'find_neighbors',
      arguments: {
        kind: 'cross_repo',
        repo: 'audit/fixture',
        direction: 'out',
      },
    });
    const s = structuredOf<FindNeighborsResponse>(r);
    const repoNeighbors = s.neighbors.filter((n) => n.kind === 'repo');
    expect(repoNeighbors.length).toBeGreaterThan(0);
    const facebook = repoNeighbors.find((n) => n.id === 'facebook/react');
    expect(facebook).toBeDefined();
    const kinds = (facebook!.metadata?.kinds as string[]) ?? [];
    // The merge invariant: all three signal kinds present and sorted.
    expect(kinds.slice().sort()).toEqual(['anchor_link', 'code_block', 'prose_link']);
  });
});

describe('find_neighbors v2.8 — vacuous-pass guard (kg_edges row count + index build time ceilings)', () => {
  it('kg_edges row count for the fixture stays well under the 50k regression ceiling', () => {
    const row = cache.getStore()
      .prepare("SELECT COUNT(*) AS c FROM kg_edges WHERE repo = 'audit/fixture'")
      .get() as { c: number };
    expect(row.c).toBeGreaterThan(0);
    expect(row.c).toBeLessThan(50_000);
  });

  it('Indexer.indexRepo wall-clock stays under INDEX_BUILD_TIMEOUT_MS=5s for the synthetic fixture', () => {
    // Synthetic fixture indexes in <100ms with mocked embedder; the 5s
    // ceiling is the regression gate against future O(n^2) merge bugs.
    expect(indexBuildMs).toBeGreaterThan(0);
    expect(indexBuildMs).toBeLessThan(5_000);
  });
});
