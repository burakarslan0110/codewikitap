/**
 * graph_query unit tests.
 *
 * Exercises the four user-facing query kinds plus the dep_link query-time
 * derivation against:
 *   - a synthetic edge set seeded directly into the GraphStore,
 *   - a stubbed Indexer for the timeout-race path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';
import { GraphStore } from '../../src/services/graph_store.js';
import { VectorStore } from '../../src/services/vector_store.js';
import { GraphQuery } from '../../src/services/graph_query.js';
import { Indexer, IndexerResult } from '../../src/services/indexer.js';
import type { KgEdge, ProjectScan } from '../../src/types.js';

const SHA = 'a'.repeat(40);

function edge(over: Partial<KgEdge>): KgEdge {
  return {
    srcKind: 'section',
    srcId: 'fixture/repo#core',
    dstKind: 'file',
    dstId: 'fixture/repo:src/index.ts',
    edgeType: 'code_ref',
    repo: 'fixture/repo',
    metadata: { sha: SHA },
    commitSha: SHA,
    indexedAt: 1_000_000,
    ...over,
  };
}

let tmpDir: string;
let cache: Cache;
let graphStore: GraphStore;
let vectorStore: VectorStore;
let stubIndexer: Pick<Indexer, 'indexRepo'>;
let indexCallCount = 0;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-gq-'));
  cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
  graphStore = new GraphStore(cache);
  vectorStore = new VectorStore(cache);
  indexCallCount = 0;
  stubIndexer = {
    indexRepo: async (): Promise<IndexerResult> => {
      indexCallCount += 1;
      return { status: 'ready', chunkCount: 1, edgeCount: 1 };
    },
  };
});

afterEach(() => {
  cache.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function freshIndexedRepo(repo: string, sha = SHA, edgeCount = 1): void {
  vectorStore.upsertWikiIndexStatus(repo, sha, 1, edgeCount);
}

// ---------------------------------------------------------------------------
// pages_referencing_file
// ---------------------------------------------------------------------------

describe('GraphQuery — pagesReferencingFile', () => {
  it('returns section neighbors that reference the file (with github_repo)', async () => {
    graphStore.upsertEdges([
      edge({ srcId: 'fixture/repo#core', dstId: 'facebook/react:src/foo.ts', repo: 'fixture/repo' }),
      edge({ srcId: 'other/repo#a', dstId: 'facebook/react:src/foo.ts', repo: 'other/repo' }),
    ]);
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.pagesReferencingFile({ filePath: 'src/foo.ts', githubRepo: 'facebook/react' });
    expect(r.neighbors).toHaveLength(2);
    expect(r.neighbors.every((n) => n.kind === 'section')).toBe(true);
    expect(r.neighbors.every((n) => n.edge_type === 'code_ref')).toBe(true);
  });

  it('without github_repo, scans every owning repo for the path', async () => {
    graphStore.upsertEdges([
      edge({ srcId: 'A#a', dstId: 'A:src/index.ts', repo: 'A' }),
      edge({ srcId: 'B#a', dstId: 'B:src/index.ts', repo: 'B' }),
      edge({ srcId: 'A#b', dstId: 'A:src/foo.ts', repo: 'A' }),
    ]);
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.pagesReferencingFile({ filePath: 'src/index.ts' });
    expect(r.neighbors).toHaveLength(2);
    expect(r.neighbors.map((n) => n.id).sort()).toEqual(['A#a', 'B#a']);
  });

  it('returns status=no_docs reason=no_indexed_repos when nothing is indexed and no github_repo set', async () => {
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.pagesReferencingFile({ filePath: 'src/missing.ts' });
    expect(r.neighbors).toHaveLength(0);
    expect(r.status).toBe('no_docs');
    expect(r.reason).toBe('no_indexed_repos');
  });

  it('does NOT trigger indexer when github_repo is unset', async () => {
    freshIndexedRepo('A');
    graphStore.upsertEdges([edge({ srcId: 'A#a', dstId: 'A:src/x.ts', repo: 'A' })]);
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    await q.pagesReferencingFile({ filePath: 'src/x.ts' });
    expect(indexCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// section_links
// ---------------------------------------------------------------------------

describe('GraphQuery — sectionLinks', () => {
  beforeEach(async () => {
    freshIndexedRepo('fixture/repo');
    graphStore.upsertEdges([
      edge({
        srcKind: 'section',
        srcId: 'fixture/repo#a',
        dstKind: 'section',
        dstId: 'fixture/repo#b',
        edgeType: 'section_link',
        repo: 'fixture/repo',
      }),
      edge({
        srcKind: 'section',
        srcId: 'fixture/repo#a',
        dstKind: 'section',
        dstId: 'fixture/repo#c',
        edgeType: 'section_link',
        repo: 'fixture/repo',
      }),
      edge({
        srcKind: 'section',
        srcId: 'fixture/repo#x',
        dstKind: 'section',
        dstId: 'fixture/repo#a',
        edgeType: 'section_link',
        repo: 'fixture/repo',
      }),
    ]);
  });

  it('direction=out returns sections that "a" links TO', async () => {
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.sectionLinks({ repo: 'fixture/repo', sectionSlug: 'a', direction: 'out' });
    expect(r.neighbors.map((n) => n.id).sort()).toEqual(['fixture/repo#b', 'fixture/repo#c']);
    expect(r.neighbors.every((n) => n.direction === 'out')).toBe(true);
  });

  it('direction=in returns sections that link TO "a"', async () => {
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.sectionLinks({ repo: 'fixture/repo', sectionSlug: 'a', direction: 'in' });
    expect(r.neighbors.map((n) => n.id)).toEqual(['fixture/repo#x']);
    expect(r.neighbors[0].direction).toBe('in');
  });

  it('direction=both returns the union with correct direction labels', async () => {
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.sectionLinks({ repo: 'fixture/repo', sectionSlug: 'a', direction: 'both' });
    expect(r.neighbors).toHaveLength(3);
    const out = r.neighbors.filter((n) => n.direction === 'out').map((n) => n.id).sort();
    const inb = r.neighbors.filter((n) => n.direction === 'in').map((n) => n.id);
    expect(out).toEqual(['fixture/repo#b', 'fixture/repo#c']);
    expect(inb).toEqual(['fixture/repo#x']);
  });
});

// ---------------------------------------------------------------------------
// diagram_neighbors
// ---------------------------------------------------------------------------

describe('GraphQuery — diagramNeighbors', () => {
  beforeEach(async () => {
    freshIndexedRepo('fixture/repo');
    graphStore.upsertEdges([
      edge({
        srcKind: 'section',
        srcId: 'fixture/repo#core',
        dstKind: 'diagram_node',
        dstId: 'fixture/repo#core::n1',
        edgeType: 'diagram_member',
        repo: 'fixture/repo',
        metadata: { label: 'Start' },
      }),
      edge({
        srcKind: 'section',
        srcId: 'fixture/repo#core',
        dstKind: 'diagram_node',
        dstId: 'fixture/repo#core::n2',
        edgeType: 'diagram_member',
        repo: 'fixture/repo',
        metadata: { label: 'End' },
      }),
      edge({
        srcKind: 'diagram_node',
        srcId: 'fixture/repo#core::n1',
        dstKind: 'diagram_node',
        dstId: 'fixture/repo#core::n2',
        edgeType: 'diagram_edge',
        repo: 'fixture/repo',
      }),
    ]);
  });

  it('section-only mode returns members + structural edges', async () => {
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.diagramNeighbors({ repo: 'fixture/repo', sectionSlug: 'core' });
    const members = r.neighbors.filter((n) => n.edge_type === 'diagram_member');
    const structural = r.neighbors.filter((n) => n.edge_type === 'diagram_edge');
    expect(members.map((m) => m.id).sort()).toEqual(['fixture/repo#core::n1', 'fixture/repo#core::n2']);
    expect(structural).toHaveLength(1);
  });

  it('node-specific mode returns in/out neighbors of the diagram node', async () => {
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.diagramNeighbors({ repo: 'fixture/repo', sectionSlug: 'core', diagramNodeId: 'n1' });
    // n1 → n2 (out)
    expect(r.neighbors.find((n) => n.direction === 'out')?.id).toBe('fixture/repo#core::n2');
  });
});

// ---------------------------------------------------------------------------
// cross_repo
// ---------------------------------------------------------------------------

describe('GraphQuery — crossRepo', () => {
  it('direction=out aggregates section-level cross_repo_ref rows by dst_id', async () => {
    freshIndexedRepo('A');
    graphStore.upsertEdges([
      edge({ srcId: 'A#x', dstKind: 'repo', dstId: 'B', edgeType: 'cross_repo_ref', repo: 'A' }),
      edge({ srcId: 'A#y', dstKind: 'repo', dstId: 'B', edgeType: 'cross_repo_ref', repo: 'A' }),
      edge({ srcId: 'A#z', dstKind: 'repo', dstId: 'C', edgeType: 'cross_repo_ref', repo: 'A' }),
    ]);
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.crossRepo({ repo: 'A', direction: 'out' });
    const repoNeighbors = r.neighbors.filter((n) => n.edge_type === 'cross_repo_ref');
    expect(repoNeighbors).toHaveLength(2);
    const b = repoNeighbors.find((n) => n.id === 'B');
    expect((b!.metadata!.from_sections as string[]).sort()).toEqual(['x', 'y']);
  });

  it('direction=in groups by owning repo (one neighbor per source repo)', async () => {
    freshIndexedRepo('B');
    graphStore.upsertEdges([
      edge({ srcId: 'A#x', dstKind: 'repo', dstId: 'B', edgeType: 'cross_repo_ref', repo: 'A' }),
      edge({ srcId: 'A#y', dstKind: 'repo', dstId: 'B', edgeType: 'cross_repo_ref', repo: 'A' }),
      edge({ srcId: 'C#z', dstKind: 'repo', dstId: 'B', edgeType: 'cross_repo_ref', repo: 'C' }),
    ]);
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.crossRepo({ repo: 'B', direction: 'in' });
    const ids = r.neighbors.filter((n) => n.edge_type === 'cross_repo_ref').map((n) => n.id).sort();
    expect(ids).toEqual(['A', 'C']);
  });

  it('merges dep_link derivation when getProjectDeps returns indexed deps', async () => {
    freshIndexedRepo('A');
    freshIndexedRepo('facebook/react');
    // No stored cross_repo_ref edges for A → facebook/react.
    const projectScan: ProjectScan = {
      projectRoot: '/tmp',
      manifestType: 'package.json',
      dependencies: [{ name: 'react', ecosystem: 'npm' }],
    };
    cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');

    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.crossRepo({
      repo: 'A',
      direction: 'out',
      getProjectDeps: () => projectScan,
    });
    const dl = r.neighbors.find((n) => n.edge_type === 'dep_link');
    expect(dl).toBeDefined();
    expect(dl!.id).toBe('facebook/react');
    expect(dl!.metadata?.derivation).toBe('project_scan');
  });

  it('dep_link derivation excludes deps that are NOT indexed', async () => {
    freshIndexedRepo('A');
    // facebook/react is NOT indexed.
    const projectScan: ProjectScan = {
      projectRoot: '/tmp',
      manifestType: 'package.json',
      dependencies: [{ name: 'react', ecosystem: 'npm' }],
    };
    cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');

    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.crossRepo({
      repo: 'A',
      direction: 'out',
      getProjectDeps: () => projectScan,
    });
    expect(r.neighbors.filter((n) => n.edge_type === 'dep_link')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// index_building timeout race
// ---------------------------------------------------------------------------

describe('GraphQuery — index_building timeout race', () => {
  it('returns status=index_building when indexRepo exceeds timeout for a repo-bound query', async () => {
    const slowIndexer: Pick<Indexer, 'indexRepo'> = {
      indexRepo: () =>
        new Promise<IndexerResult>((resolve) =>
          setTimeout(() => resolve({ status: 'ready', chunkCount: 0, edgeCount: 0 }), 200),
        ),
    };
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: slowIndexer });
    const r = await q.sectionLinks({
      repo: 'never-indexed/repo',
      sectionSlug: 'a',
      direction: 'out',
      timeoutMs: 50,
    } as Parameters<typeof q.sectionLinks>[0] & { timeoutMs: number });
    expect(r.status).toBe('index_building');
    expect(r.neighbors).toEqual([]);
  });

  it('skips indexer when the repo is already indexed and fresh', async () => {
    freshIndexedRepo('fixture/repo');
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    await q.sectionLinks({ repo: 'fixture/repo', sectionSlug: 'a', direction: 'out' });
    expect(indexCallCount).toBe(0);
  });

  it('forces indexer when wiki_index_status.edge_count < 0 sentinel (Codex graph-readiness fix)', async () => {
    // edge_count = -1 sentinel means "graph never built for this row" —
    // the lifecycle invariant requires a rebuild even if the chunks are
    // fresh. Without this guard, find_neighbors would return empty for a
    // repo where v2 (chunks-only) wrote the row before v2.1 added KG.
    vectorStore.upsertWikiIndexStatus('fixture/repo', SHA, 5, -1);
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    await q.sectionLinks({ repo: 'fixture/repo', sectionSlug: 'a', direction: 'out' });
    expect(indexCallCount).toBe(1);
  });

  it('does NOT trigger the indexer for pages_referencing_file even when github_repo is set (Codex finding)', async () => {
    // pages_referencing_file's `github_repo` is a FILTER on the file's
    // GitHub owner, not a "force-index this repo" signal. The OWNING repo
    // (the repo whose section references the file) is whoever extracted
    // the code_ref edge, which may be unrelated to github_repo.
    graphStore.upsertEdges([
      edge({ srcId: 'A#a', dstId: 'facebook/react:src/foo.ts', repo: 'A' }),
    ]);
    freshIndexedRepo('A');
    // facebook/react is NOT in wiki_index_status — would normally trigger
    // indexer.indexRepo. Asserting that it doesn't.
    const q = new GraphQuery({ graphStore, vectorStore, cache, indexer: stubIndexer });
    const r = await q.pagesReferencingFile({ filePath: 'src/foo.ts', githubRepo: 'facebook/react' });
    expect(indexCallCount).toBe(0);
    expect(r.neighbors.find((n) => n.id === 'A#a')).toBeDefined();
  });
});

// v2.5: find_neighbors WITHOUT query MUST NOT load the embedder model
// (preserves the v2.1 KG-only divergence invariant — see KG rule update).
describe('GraphQuery — embedder lazy-load divergence (v2.5)', () => {
  it('does NOT call embedder.encode when query is omitted', async () => {
    let encodeCallCount = 0;
    const spyEmbedder = {
      encode: async (texts: string[]): Promise<Float32Array[]> => {
        encodeCallCount++;
        return texts.map(() => new Float32Array(384));
      },
      getFingerprint: () => ({ model: 'spy', dim: 384 }),
    } as unknown as import('../../src/adapters/embedder.js').Embedder;

    const q = new GraphQuery({
      graphStore,
      vectorStore,
      cache,
      indexer: stubIndexer,
      embedder: spyEmbedder,
    });

    graphStore.upsertEdges([
      edge({
        srcKind: 'section',
        srcId: 'A#a',
        dstKind: 'section',
        dstId: 'A#b',
        edgeType: 'section_link',
        repo: 'A',
      }),
    ]);
    freshIndexedRepo('A');

    await q.sectionLinks({ repo: 'A', sectionSlug: 'a', direction: 'both' });
    expect(encodeCallCount).toBe(0);

    // With `query` set, encode IS called (queries the model).
    await q.sectionLinks({ repo: 'A', sectionSlug: 'a', direction: 'both', query: 'authentication' });
    expect(encodeCallCount).toBeGreaterThan(0);
  });
});
