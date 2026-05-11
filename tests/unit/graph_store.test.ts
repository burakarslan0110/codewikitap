/**
 * graph_store unit tests.
 *
 * Covers BOTH the native (better-sqlite3) and in-memory backend by running
 * the same test set under FORCE_INMEMORY_CACHE=1 and without the flag.
 *
 * Critical paths:
 *   - upsertEdges + findEdges round-trip (by src, by dst, by repo only)
 *   - dropForRepo invalidation scoped to one repo
 *   - sort + JS-side limit (in-memory parser doesn't support ORDER BY/LIMIT)
 *   - SHA-agnostic file lookup on the cross-repo `pages_referencing_file` path
 *   - metadata round-trip preserves nested JSON shape
 *   - open-scan rejection (no src, no dst, no repo) throws
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';
import { GraphStore } from '../../src/services/graph_store.js';
import type { KgEdge, KgNodeRef } from '../../src/types.js';

let tmpDir: string;
async function makeNativeStore(): Promise<{ cache: Cache; store: GraphStore }> {
  const cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
  return { cache, store: new GraphStore(cache) };
}
async function makeInMemoryStore(): Promise<{ cache: Cache; store: GraphStore }> {
  const cache = await Cache.open({ forceInMemory: true });
  return { cache, store: new GraphStore(cache) };
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwm-gs-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

function edge(over: Partial<KgEdge> = {}): KgEdge {
  const sha = 'a'.repeat(40);
  return {
    srcKind: 'section',
    srcId: 'fixture/repo#core',
    dstKind: 'file',
    dstId: 'fixture/repo:src/index.ts',
    edgeType: 'code_ref',
    repo: 'fixture/repo',
    metadata: { sha },
    commitSha: sha,
    indexedAt: 1_000_000,
    ...over,
  };
}

const backends: Array<{ name: string; setup: () => Promise<{ cache: Cache; store: GraphStore }> }> = [
  { name: 'native', setup: makeNativeStore },
  { name: 'in-memory', setup: makeInMemoryStore },
];

for (const backend of backends) {
  describe(`GraphStore (${backend.name} backend)`, () => {
    it('round-trips upsertEdges → findEdges by src', async () => {
      const { cache, store } = await backend.setup();
      const e = edge();
      store.upsertEdges([e]);
      const result = store.findEdges({ src: { kind: 'section', id: 'fixture/repo#core' }, edgeType: 'code_ref' });
      expect(result).toHaveLength(1);
      expect(result[0].dstId).toBe('fixture/repo:src/index.ts');
      cache.close();
    });

    it('round-trips by dst', async () => {
      const { cache, store } = await backend.setup();
      store.upsertEdges([edge()]);
      const result = store.findEdges({ dst: { kind: 'file', id: 'fixture/repo:src/index.ts' }, edgeType: 'code_ref' });
      expect(result).toHaveLength(1);
      cache.close();
    });

    it('round-trips by repo only (cross_repo `out` aggregation path)', async () => {
      const { cache, store } = await backend.setup();
      store.upsertEdges([
        edge({ srcId: 'fixture/repo#a', dstKind: 'repo', dstId: 'facebook/react', edgeType: 'cross_repo_ref' }),
        edge({ srcId: 'fixture/repo#b', dstKind: 'repo', dstId: 'vercel/next.js', edgeType: 'cross_repo_ref' }),
        edge({ srcId: 'other/repo#a', dstKind: 'repo', dstId: 'facebook/react', edgeType: 'cross_repo_ref', repo: 'other/repo' }),
      ]);
      const result = store.findEdges({ repo: 'fixture/repo', edgeType: 'cross_repo_ref' });
      expect(result).toHaveLength(2);
      const dstIds = result.map((r) => r.dstId).sort();
      expect(dstIds).toEqual(['facebook/react', 'vercel/next.js']);
      cache.close();
    });

    it('rejects open scan when no src, dst, or repo is provided', async () => {
      const { cache, store } = await backend.setup();
      expect(() => store.findEdges({ edgeType: 'code_ref' })).toThrow();
      cache.close();
    });

    it('dropForRepo removes only that repo`s edges', async () => {
      const { cache, store } = await backend.setup();
      store.upsertEdges([
        edge({ srcId: 'A#a', repo: 'A' }),
        edge({ srcId: 'B#b', repo: 'B' }),
      ]);
      store.dropForRepo('A');
      expect(store.edgeCountForRepo('A')).toBe(0);
      expect(store.edgeCountForRepo('B')).toBe(1);
      cache.close();
    });

    it('metadata round-trips with nested JSON shape', async () => {
      const { cache, store } = await backend.setup();
      const md = { kinds: ['anchor_link', 'code_block'], anchor: 'core-hooks', nested: { foo: 1, bar: ['x', 'y'] } };
      store.upsertEdges([edge({ metadata: md })]);
      const result = store.findEdges({ src: { kind: 'section', id: 'fixture/repo#core' }, edgeType: 'code_ref' });
      expect(result[0].metadata).toEqual(md);
      cache.close();
    });

    it('limit is applied JS-side after sort', async () => {
      const { cache, store } = await backend.setup();
      store.upsertEdges([
        edge({ srcId: 'fixture/repo#a', dstId: 'fixture/repo:a.ts', indexedAt: 100 }),
        edge({ srcId: 'fixture/repo#b', dstId: 'fixture/repo:b.ts', indexedAt: 200 }),
        edge({ srcId: 'fixture/repo#c', dstId: 'fixture/repo:c.ts', indexedAt: 300 }),
      ]);
      const result = store.findEdges({ repo: 'fixture/repo', edgeType: 'code_ref', limit: 2 });
      expect(result).toHaveLength(2);
      // Sort is `indexed_at desc` — most recent two come back.
      expect(result.map((r) => r.dstId)).toEqual(['fixture/repo:c.ts', 'fixture/repo:b.ts']);
      cache.close();
    });

    it('SHA-agnostic file lookup matches across owning repos by path', async () => {
      // pages_referencing_file({ file_path: 'src/index.ts' }) without
      // github_repo → must match every code_ref whose dstId ends with
      // ':src/index.ts' regardless of which repo owns the file.
      const { cache, store } = await backend.setup();
      store.upsertEdges([
        edge({ srcId: 'fixture/repo#a', dstId: 'fixture/repo:src/index.ts', repo: 'fixture/repo' }),
        edge({ srcId: 'other/repo#a', dstId: 'other/repo:src/index.ts', repo: 'other/repo' }),
        edge({ srcId: 'other/repo#b', dstId: 'other/repo:src/foo.ts', repo: 'other/repo' }),
      ]);
      const result = store.findEdgesByFilePath('src/index.ts');
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.edgeType === 'code_ref')).toBe(true);
      const dsts = result.map((r) => r.dstId).sort();
      expect(dsts).toEqual(['fixture/repo:src/index.ts', 'other/repo:src/index.ts']);
      cache.close();
    });

    it('upsertEdges replaces an existing PK row (no duplicate)', async () => {
      const { cache, store } = await backend.setup();
      store.upsertEdges([edge({ metadata: { sha: 'a'.repeat(40) } })]);
      store.upsertEdges([edge({ metadata: { sha: 'b'.repeat(40) }, indexedAt: 2_000_000 })]);
      const result = store.findEdges({ repo: 'fixture/repo', edgeType: 'code_ref' });
      expect(result).toHaveLength(1);
      expect(result[0].metadata).toEqual({ sha: 'b'.repeat(40) });
      cache.close();
    });
  });
}
