/**
 * AUDIT_TS_021..024 — find_neighbors v2.5 semantic-rank invariants.
 *
 *   021 — score-field shape: `query` set → section/diagram_node neighbors
 *         carry numeric `score` in [0, 1]; file/repo neighbors do NOT.
 *   022 — ordering-quality threshold: on the deterministic fixture,
 *         semantic-rank ranks `core` above `api` for an entry-point query.
 *   023 — lazy-load divergence: find_neighbors WITHOUT `query` must not
 *         invoke `embedder.encode`. WITH `query` it MUST encode the literal
 *         query string at graph_query.ts:553 (input-string capture, not
 *         just call count).
 *   024 — embedder error → retry envelope: when the query-encode site
 *         throws `EmbedderError`, find_neighbors returns
 *         `{ status: 'retry', retryAfterSeconds: 60, reason: /embedder .../, neighbors: [] }`.
 *
 * Wired via InMemoryTransport. Embedder and reranker are mocked at the
 * buildServer seam so the audit is offline-deterministic. The fixture used
 * is `fixtureExtractionWithKgEdges()` so `Indexer.indexRepo('audit/fixture')`
 * emits `section_link` edges (overview → core, overview → api).
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
import { EmbedderError } from '../../src/types.js';
import { EMBED_MODEL_DIM } from '../../src/config_rag.js';
import { mkTempDirs, fixtureExtractionWithKgEdges, notFoundExtraction } from './scenarios.js';

/**
 * Deterministic embedder with content-aware components matching the
 * KG semantic-rank test queries. Extends the base deterministicEmbed
 * pattern from per_tool.audit.test.ts with components for 'core', 'api',
 * 'entry', and 'authentication' so cosine similarity discriminates between
 * core-section chunks and api-section chunks on the test queries.
 */
function kgSemanticEmbed(text: string): Float32Array {
  const v = new Float32Array(EMBED_MODEL_DIM);
  let acc = 0;
  for (let i = 0; i < text.length; i++) acc = (acc * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < v.length; i++) {
    acc = (acc * 1103515245 + 12345) >>> 0;
    v[i] = ((acc & 0xffff) / 0xffff - 0.5) * 0.01;
  }
  const lower = text.toLowerCase();
  v[0] = (text.length % 8) / 8;
  v[1] = lower.includes('core') ? 1 : 0;
  v[2] = lower.includes('api') ? 1 : 0;
  v[3] = lower.includes('entry') ? 1 : 0;
  v[4] = lower.includes('authentic') ? 1 : 0;
  v[5] = lower.includes('hooks') ? 1 : 0;
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / norm;
  return v;
}

const SHARED_EMBEDDER_FINGERPRINT = { model: 'audit/mock-encoder', dim: EMBED_MODEL_DIM };

function makeMockEmbedder(): Embedder {
  return {
    async encode(texts: string[]): Promise<Float32Array[]> {
      return texts.map(kgSemanticEmbed);
    },
    getFingerprint() {
      return SHARED_EMBEDDER_FINGERPRINT;
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

async function setupServerWith(embedder: Embedder): Promise<SetupHandles> {
  const dirs = mkTempDirs('codewiki-audit-kg-semantic');
  fs.writeFileSync(
    path.join(dirs.projectDir, 'package.json'),
    JSON.stringify({ name: 'audit-fixture', version: '0.0.1', dependencies: {} }),
  );
  const cache = await Cache.open({ dbPath: path.join(dirs.cacheDir, 'cache.db') });
  const cwClient = new CodeWikiClient(new PlaywrightDriver(), cache);
  cwClient.fetchPage = async (repo: string) =>
    repo === 'audit/fixture' ? fixtureExtractionWithKgEdges() : notFoundExtraction();
  const built = await buildServer({
    cwd: dirs.projectDir,
    cache,
    client: cwClient,
    embedder,
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

// Two-call race helper for find_neighbors during indexer warm-up.
async function callNeighborsRaceSafe(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let r = await client.callTool({ name: 'find_neighbors', arguments: args });
  let s = struct(r);
  if (s.status === 'index_building') {
    r = await client.callTool({ name: 'find_neighbors', arguments: args });
    s = struct(r);
  }
  return s;
}

// ----- AUDIT_TS_021: score field shape -----
describe('AUDIT_TS_021: find_neighbors query → score field on section/diagram_node; absent on file/repo', () => {
  let h: SetupHandles;
  beforeEach(async () => { h = await setupServerWith(makeMockEmbedder()); });
  afterEach(async () => { await teardown(h); });

  it('section neighbors carry numeric score in [0, 1] when query is set', async () => {
    // Warm indexer first (so find_neighbors hits the populated graph).
    await h.mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture', prepareOnly: true } });

    const s = await callNeighborsRaceSafe(h.mcpClient, {
      kind: 'section_links',
      repo: 'audit/fixture',
      section_slug: 'overview',
      direction: 'out',
      query: 'core architecture entry point',
    });

    const neighbors = s.neighbors as Array<{ kind: string; id: string; score?: unknown }>;
    expect(Array.isArray(neighbors)).toBe(true);
    expect(neighbors.length).toBeGreaterThan(0);
    const sectionNeighbors = neighbors.filter((n) => n.kind === 'section');
    expect(sectionNeighbors.length).toBeGreaterThan(0);
    for (const n of sectionNeighbors) {
      expect(typeof n.score).toBe('number');
      expect(n.score as number).toBeGreaterThanOrEqual(0);
      expect(n.score as number).toBeLessThanOrEqual(1);
    }
  });

  it('repo neighbors (cross_repo) do NOT carry score field when query is set', async () => {
    await h.mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture', prepareOnly: true } });

    const s = await callNeighborsRaceSafe(h.mcpClient, {
      kind: 'cross_repo',
      repo: 'audit/fixture',
      direction: 'out',
      query: 'cross repo dependency',
    });

    const neighbors = (s.neighbors as Array<{ kind: string; id: string; score?: unknown }>) ?? [];
    // The fixture's core-hooks prose contains a CodeWiki cross-repo URL to
    // `facebook/react` which the canonical-tree extractor turns into a
    // `cross_repo_ref` edge (per src/services/graph_extractor.ts). The
    // ensured edge prevents the for-loop below from passing vacuously when
    // `neighbors` is empty.
    expect(neighbors.length).toBeGreaterThan(0);
    const repoOrFileNeighbors = neighbors.filter((n) => n.kind === 'repo' || n.kind === 'file');
    expect(repoOrFileNeighbors.length).toBeGreaterThan(0);
    for (const n of repoOrFileNeighbors) {
      expect(n.score).toBeUndefined();
    }
  });
});

// ----- AUDIT_TS_022: ordering quality on deterministic fixture -----
describe('AUDIT_TS_022: find_neighbors semantic-rank ordering quality on deterministic fixture', () => {
  let h: SetupHandles;
  beforeEach(async () => { h = await setupServerWith(makeMockEmbedder()); });
  afterEach(async () => { await teardown(h); });

  it('section_links(overview, out, query="core architecture entry point") ranks core above api', async () => {
    await h.mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture', prepareOnly: true } });

    const s = await callNeighborsRaceSafe(h.mcpClient, {
      kind: 'section_links',
      repo: 'audit/fixture',
      section_slug: 'overview',
      direction: 'out',
      query: 'core architecture entry point',
    });

    const neighbors = s.neighbors as Array<{ kind: string; id: string; score?: number }>;
    expect(neighbors.length).toBeGreaterThanOrEqual(2);

    // Top-1 binary assertion (insensitive to float-epsilon score collapse).
    expect(neighbors[0].id).toBe('audit/fixture#core');

    // Ordering-metric assertion mirroring scripts/eval.ts evalKgSemantic logic.
    const expectedOrder = ['audit/fixture#core'];
    const returnedOrder = neighbors.map((n) => n.id);
    let scoreSum = 0;
    for (let i = 0; i < expectedOrder.length; i++) {
      const idx = returnedOrder.indexOf(expectedOrder[i]);
      if (idx >= 0 && idx <= i) scoreSum += 1;
      else if (idx >= 0) scoreSum += 0.5;
    }
    const ordering = scoreSum / expectedOrder.length;
    expect(ordering).toBeGreaterThanOrEqual(0.7);
  });
});

// ----- AUDIT_TS_023: lazy-load divergence (input-string capture) -----
describe('AUDIT_TS_023: find_neighbors WITHOUT query does NOT load embedder', () => {
  it('no-query path: zero post-baseline encode calls; with-query path: at least one call has inputs=[query]', async () => {
    const encodeInputs: string[][] = [];
    const spyEmbedder = {
      async encode(texts: string[]): Promise<Float32Array[]> {
        encodeInputs.push(texts.slice());
        return texts.map(kgSemanticEmbed);
      },
      getFingerprint() {
        return SHARED_EMBEDDER_FINGERPRINT;
      },
      close() {},
    } as unknown as Embedder;

    const h = await setupServerWith(spyEmbedder);
    try {
      // Warm indexer; subsequent encode calls inside find_neighbors are what
      // the assertions care about. Snapshot baseline AFTER get_page({prepareOnly:true}).
      await h.mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture', prepareOnly: true } });
      const encodeInputsBaselineLen = encodeInputs.length;

      // No-query branch: must not invoke encode.
      const noQueryStruct = await callNeighborsRaceSafe(h.mcpClient, {
        kind: 'section_links',
        repo: 'audit/fixture',
        section_slug: 'overview',
        direction: 'out',
      });
      expect(noQueryStruct.neighbors).toBeDefined();
      expect(encodeInputs.length).toBe(encodeInputsBaselineLen);

      // With-query branch: query-encode site at graph_query.ts:553 calls
      // `embedder.encode([query])` literally. AT LEAST ONE post-baseline call
      // must have inputs deeply equal to [query].
      const queryStr = 'core architecture entry point';
      const withQueryStruct = await callNeighborsRaceSafe(h.mcpClient, {
        kind: 'section_links',
        repo: 'audit/fixture',
        section_slug: 'overview',
        direction: 'out',
        query: queryStr,
      });
      expect(withQueryStruct.neighbors).toBeDefined();
      expect(encodeInputs.length).toBeGreaterThan(encodeInputsBaselineLen);
      const postBaseline = encodeInputs.slice(encodeInputsBaselineLen);
      const hasQueryEncodeCall = postBaseline.some(
        (inputs) => inputs.length === 1 && inputs[0] === queryStr,
      );
      expect(hasQueryEncodeCall).toBe(true);
    } finally {
      await teardown(h);
    }
  });
});

// ----- AUDIT_TS_024: embedder error → retry envelope -----
describe('AUDIT_TS_024: find_neighbors with embedder error → status=retry + retryAfterSeconds=60', () => {
  it('throwing-embedder at query-encode site (graph_query.ts:553) returns retry envelope, no neighbors', async () => {
    let beforeBaseline = true;
    const queryStr = 'simulated query';
    const throwingEmbedder = {
      async encode(texts: string[]): Promise<Float32Array[]> {
        // Pre-baseline (indexer chunk-build) succeeds with deterministic vectors.
        // Post-baseline, the exact-string match on `'simulated query'` traps
        // the query-encode site at graph_query.ts:553. Section-encode at :581
        // passes joined chunk text (not equal to queryStr) so it succeeds —
        // pinning the trap to the query-encode path.
        // NOTE: EmbedderErrorKind is `'download_failed' | 'encode_failed' | 'dim_mismatch'`
        // (src/types.ts:192). `'download_failed'` is the realistic kind for
        // model-fetch failures; the retry-reason regex below pins this exact
        // string per the envelope template at src/services/graph_query.ts:563
        // (`embedder ${err.kind}: ${err.message}`).
        if (!beforeBaseline && texts.length === 1 && texts[0] === queryStr) {
          throw new EmbedderError('download_failed', 'simulated download failure');
        }
        return texts.map(kgSemanticEmbed);
      },
      getFingerprint() {
        return SHARED_EMBEDDER_FINGERPRINT;
      },
      close() {},
    } as unknown as Embedder;

    const h = await setupServerWith(throwingEmbedder);
    try {
      // Warm indexer (succeeds — pre-baseline path).
      await h.mcpClient.callTool({ name: 'get_page', arguments: { repo: 'audit/fixture', prepareOnly: true } });
      beforeBaseline = false;

      // Query-encode path throws → retriever's catch at graph_query.ts:554-568
      // emits the retry envelope.
      const s = await callNeighborsRaceSafe(h.mcpClient, {
        kind: 'section_links',
        repo: 'audit/fixture',
        section_slug: 'overview',
        direction: 'out',
        query: queryStr,
      });

      expect(s.status).toBe('retry');
      expect(s.retryAfterSeconds).toBe(60);
      expect(s.reason as string).toMatch(/embedder download_failed/);
      const neighbors = (s.neighbors as unknown[]) ?? [];
      expect(neighbors.length).toBe(0);
    } finally {
      await teardown(h);
    }
  });
});
