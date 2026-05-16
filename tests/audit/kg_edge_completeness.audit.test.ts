/**
 * AUDIT_TS_025..028 — v2.8 KG edge-extraction completeness invariants.
 *
 *   025 — graph_extractor emits code_ref + cross_repo_ref{kinds:['prose_link']}
 *         from prose-level https://github.com/<owner>/<repo>/blob/<sha>/<path>
 *         URLs inside ProseNode.markdown.
 *   026 — dom_to_tree extracts diagram nodes/edges from base64-wrapped
 *         Graphviz SVG inside the outer <svg> wrapper (the production shape
 *         confirmed in captured fixtures: react.html has 71/71 diagrams
 *         using this shape).
 *   027 — cross_repo_ref kinds union dedups CodeNode (code_block),
 *         CodeWiki anchor URL (anchor_link), and prose-level github URL
 *         (prose_link) into ONE row whose `kinds` is the sorted union.
 *   028 — end-to-end: find_neighbors returns >=1 neighbor for all 4
 *         query kinds (pages_referencing_file, diagram_neighbors,
 *         section_links, cross_repo) against fixtureExtractionFullEdgeTypes.
 *
 * AUDIT_TS_025/026/027 are PURE — call extractEdges/extractFromDocument
 * directly against synthetic input. AUDIT_TS_028 is integration-style
 * but stays in the audit harness — uses InMemoryTransport + mocked
 * embedder + mocked fetchPage seam (offline-deterministic).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { JSDOM } from 'jsdom';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';
import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { Embedder } from '../../src/adapters/embedder.js';
import { Reranker } from '../../src/adapters/reranker.js';
import { extractEdges } from '../../src/services/graph_extractor.js';
import { extractFromDocument } from '../../src/extraction/dom_to_tree.js';
import { EMBED_MODEL_DIM } from '../../src/config_rag.js';
import { mkTempDirs, fixtureExtractionFullEdgeTypes, notFoundExtraction } from './scenarios.js';
import type { DiagramNode } from '../../src/extraction/canonical_tree.js';

// ---------------------------------------------------------------------------
// Setup helpers (mirror kg_semantic.audit.test.ts patterns).
// ---------------------------------------------------------------------------

function deterministicEmbed(text: string): Float32Array {
  const v = new Float32Array(EMBED_MODEL_DIM);
  let acc = 0;
  for (let i = 0; i < text.length; i++) acc = (acc * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < v.length; i++) {
    acc = (acc * 1103515245 + 12345) >>> 0;
    v[i] = ((acc & 0xffff) / 0xffff - 0.5) * 0.01;
  }
  v[0] = (text.length % 8) / 8;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  return v;
}

const MOCK_EMBEDDER_FINGERPRINT = { model: 'audit/mock-encoder', dim: EMBED_MODEL_DIM };

function makeMockEmbedder(): Embedder {
  return {
    async encode(texts: string[]): Promise<Float32Array[]> {
      return texts.map(deterministicEmbed);
    },
    getFingerprint() {
      return MOCK_EMBEDDER_FINGERPRINT;
    },
    close() {},
  } as unknown as Embedder;
}

const mockReranker = {
  async score(_query: string, texts: string[]): Promise<number[]> {
    return texts.map((t, i) => t.length + i * 0.001);
  },
  getFingerprint() {
    return { model: 'audit/mock-reranker' };
  },
  close() {},
} as unknown as Reranker;

function struct(r: unknown): Record<string, unknown> {
  return ((r as { structuredContent?: unknown }).structuredContent as Record<string, unknown>) ?? {};
}

interface SetupHandles {
  dirs: ReturnType<typeof mkTempDirs>;
  cache: Cache;
  mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  mcpClient: Client;
}

async function setupServerWithFullEdgeTypesFixture(): Promise<SetupHandles> {
  const dirs = mkTempDirs('codewiki-audit-kg-edges');
  fs.writeFileSync(
    path.join(dirs.projectDir, 'package.json'),
    JSON.stringify({ name: 'audit-fixture', version: '0.0.1', dependencies: {} }),
  );
  const cache = await Cache.open({ dbPath: path.join(dirs.cacheDir, 'cache.db') });
  const cwClient = new CodeWikiClient(new PlaywrightDriver(), cache);
  cwClient.fetchPage = async (repo: string) =>
    repo === 'audit/fixture' ? fixtureExtractionFullEdgeTypes() : notFoundExtraction();
  const built = await buildServer({
    cwd: dirs.projectDir,
    cache,
    client: cwClient,
    embedder: makeMockEmbedder(),
    reranker: mockReranker,
  });
  const mcpServer = built.server;
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  const mcpClient = new Client({ name: 'audit-client', version: '0.0.1' });
  await mcpClient.connect(clientT);
  return { dirs, cache, mcpServer, mcpClient };
}

async function teardown(h: SetupHandles): Promise<void> {
  try { await h.mcpClient.close(); } catch { /* ignore */ }
  try { await h.mcpServer.close(); } catch { /* ignore */ }
  h.cache.close();
  h.dirs.cleanup();
}

async function callNeighborsRaceSafe(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Bounded polling loop with 50ms backoff (mirrors v2.5 kg_semantic audit
  // helper). With beforeEach pre-warming via get_page({prepareOnly:true}) this rarely
  // triggers, but loaded CI workers can race the indexer's single-flight
  // window — a single re-call was insufficient. 5 attempts total.
  for (let i = 0; i < 5; i++) {
    const r = await client.callTool({ name: 'find_neighbors', arguments: args });
    const s = struct(r);
    if (s.status !== 'index_building') return s;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Final attempt — return whatever we get (typically a populated response
  // by now; the test assertion will fail loudly if it's still building).
  const r = await client.callTool({ name: 'find_neighbors', arguments: args });
  return struct(r);
}

// ---------------------------------------------------------------------------
// AUDIT_TS_025: prose-level github blob URLs → code_ref + cross_repo_ref
// ---------------------------------------------------------------------------

describe('AUDIT_TS_025: graph_extractor emits code_ref + cross_repo_ref from prose-level github blob URLs', () => {
  it('same-repo prose URL emits ONE code_ref with source=prose_link and NO cross_repo_ref', () => {
    const edges = extractEdges('audit/fixture', fixtureExtractionFullEdgeTypes().nodes);
    const sameRepoCodeRefs = edges.filter(
      (e) => e.edgeType === 'code_ref' && e.dstId === 'audit/fixture:src/babel/Plugin.ts',
    );
    expect(sameRepoCodeRefs).toHaveLength(1);
    expect(sameRepoCodeRefs[0].metadata).toMatchObject({ source: 'prose_link', lineRange: 'L24' });
  });

  it('cross-repo prose URL emits BOTH code_ref (to file) AND cross_repo_ref{kinds:[prose_link]}', () => {
    const edges = extractEdges('audit/fixture', fixtureExtractionFullEdgeTypes().nodes);
    const crossRepoFileRefs = edges.filter(
      (e) =>
        e.edgeType === 'code_ref' &&
        e.dstId === 'facebook/react:packages/react/src/index.ts',
    );
    expect(crossRepoFileRefs.length).toBeGreaterThan(0);
    const crossRepoEdges = edges.filter(
      (e) => e.edgeType === 'cross_repo_ref' && e.dstId === 'facebook/react',
    );
    expect(crossRepoEdges).toHaveLength(1);
    const kinds = crossRepoEdges[0].metadata?.kinds as string[];
    expect(kinds).toContain('prose_link');
  });
});

// ---------------------------------------------------------------------------
// AUDIT_TS_026: base64-wrapped Graphviz SVG decode in dom_to_tree
// ---------------------------------------------------------------------------

describe('AUDIT_TS_026: dom_to_tree extracts diagram nodes/edges from base64-wrapped Graphviz SVG', () => {
  it('production-shape <svg><image href="data:image/svg+xml;base64,..."> populates DiagramNode.nodes/edges/mermaid', () => {
    const MINI_GRAPHVIZ_SVG =
      '<svg xmlns="http://www.w3.org/2000/svg"><g class="graph">' +
      '<g id="node1" class="node"><title>n1</title><text>Start</text></g>' +
      '<g id="node2" class="node"><title>n2</title><text>End</text></g>' +
      '<g id="edge1" class="edge"><title>n1-&gt;n2</title></g>' +
      '</g></svg>';
    const b64 = Buffer.from(MINI_GRAPHVIZ_SVG).toString('base64');
    const html =
      '<!doctype html><html><body>' +
      '<body-content-section><div id="core">' +
      '<documentation-markdown><h2>Core</h2></documentation-markdown>' +
      '<code-documentation-diagram-inline>' +
      '<svg viewBox="0 0 100 100"><g>' +
      `<image href="data:image/svg+xml;base64,${b64}"/>` +
      '</g></svg>' +
      '</code-documentation-diagram-inline>' +
      '</div></body-content-section>' +
      '</body></html>';
    const doc = new JSDOM(html).window.document;
    const result = extractFromDocument(doc);
    const d = result.nodes.find((n) => n.type === 'diagram') as DiagramNode;
    expect(d).toBeDefined();
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0]).toMatchObject({ from: 'n1', to: 'n2' });
    expect(d.mermaid).toContain('flowchart TD');
    expect(d.svgBase64).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// AUDIT_TS_027: cross_repo_ref kinds union dedup (code_block + anchor_link + prose_link)
// ---------------------------------------------------------------------------

describe('AUDIT_TS_027: cross_repo_ref kinds union deduplicates code_block + anchor_link + prose_link to one row', () => {
  it('all three foreign-repo signals collapse into ONE row with sorted kinds union', () => {
    const edges = extractEdges('audit/fixture', fixtureExtractionFullEdgeTypes().nodes);
    const foreignRepoRefs = edges.filter(
      (e) => e.edgeType === 'cross_repo_ref' && e.dstId === 'facebook/react',
    );
    // Exactly ONE row — the dedup invariant.
    expect(foreignRepoRefs).toHaveLength(1);
    const kinds = (foreignRepoRefs[0].metadata?.kinds as string[]).slice().sort();
    expect(kinds).toEqual(['anchor_link', 'code_block', 'prose_link']);
  });
});

// ---------------------------------------------------------------------------
// AUDIT_TS_028: find_neighbors returns >=1 neighbor for all 4 query kinds
// ---------------------------------------------------------------------------

describe('AUDIT_TS_028: find_neighbors returns >=1 neighbor for all 4 query kinds against fully-populated synthetic fixture', () => {
  let h: SetupHandles;
  beforeEach(async () => {
    h = await setupServerWithFullEdgeTypesFixture();
    // Warm indexer so all stored edge types are populated before queries.
    await h.mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture', prepareOnly: true } });
  });
  afterEach(async () => { await teardown(h); });

  it('pages_referencing_file returns >=1 section neighbor with edge_type=code_ref', async () => {
    const s = await callNeighborsRaceSafe(h.mcpClient, {
      kind: 'pages_referencing_file',
      file_path: 'src/babel/Plugin.ts',
      github_repo: 'audit/fixture',
    });
    const neighbors = (s.neighbors as Array<{ kind: string; edge_type: string }>) ?? [];
    expect(neighbors.length).toBeGreaterThan(0);
    expect(neighbors.some((n) => n.kind === 'section' && n.edge_type === 'code_ref')).toBe(true);
  });

  it('diagram_neighbors (section-only) returns >=2 diagram_node neighbors', async () => {
    const s = await callNeighborsRaceSafe(h.mcpClient, {
      kind: 'diagram_neighbors',
      repo: 'audit/fixture',
      section_slug: 'core',
    });
    const neighbors = (s.neighbors as Array<{ kind: string; id: string }>) ?? [];
    const diagramNodes = neighbors.filter((n) => n.kind === 'diagram_node');
    expect(diagramNodes.length).toBeGreaterThanOrEqual(2);
    // Ids follow `<repo>#<slug>::<nodeId>` format.
    for (const n of diagramNodes) {
      expect(n.id).toMatch(/^audit\/fixture#core::(n1|n2)$/);
    }
  });

  it('section_links (overview, out) returns >=1 section neighbor', async () => {
    const s = await callNeighborsRaceSafe(h.mcpClient, {
      kind: 'section_links',
      repo: 'audit/fixture',
      section_slug: 'overview',
      direction: 'out',
    });
    const neighbors = (s.neighbors as Array<{ kind: string }>) ?? [];
    expect(neighbors.filter((n) => n.kind === 'section').length).toBeGreaterThan(0);
  });

  it('cross_repo (out) returns >=1 repo neighbor with metadata.kinds containing prose_link', async () => {
    const s = await callNeighborsRaceSafe(h.mcpClient, {
      kind: 'cross_repo',
      repo: 'audit/fixture',
      direction: 'out',
    });
    const neighbors =
      (s.neighbors as Array<{ kind: string; id: string; metadata?: Record<string, unknown> }>) ??
      [];
    const repoNeighbors = neighbors.filter((n) => n.kind === 'repo');
    expect(repoNeighbors.length).toBeGreaterThan(0);
    const facebook = repoNeighbors.find((n) => n.id === 'facebook/react');
    expect(facebook).toBeDefined();
    const kinds = (facebook!.metadata?.kinds as string[]) ?? [];
    expect(kinds).toContain('prose_link');
  });
});
