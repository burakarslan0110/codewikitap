/**
 * CodeWiki client cache-contract tests — deterministic, no live network.
 *
 * Stubs the page-fetch step so we can assert the documented cache flow
 * (TTL fresh / TTL expired + SHA match / TTL expired + SHA differs / miss)
 * without depending on the external SPA. Live integration test lives in
 * tests/integration/codewiki_client.integration.test.ts (skipped unless
 * network access is available).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { Cache } from '../../src/services/cache.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import type { ExtractionResult } from '../../src/extraction/canonical_tree.js';
import type { CanonicalNode } from '../../src/extraction/canonical_tree.js';
import { PAGE_TTL_MS } from '../../src/config.js';

let tmpDir: string;
let cache: Cache;
let client: CodeWikiClient;
let fetchCalls: string[];
let nextFetch: ExtractionResult | (() => ExtractionResult);

const SAMPLE_NODES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'overview', markdown: 'overview text' },
];

function res(sha: string | null = 'a'.repeat(40), notFound = false, nodes: CanonicalNode[] = SAMPLE_NODES): ExtractionResult {
  return { nodes, notFound, firstCommitSha: sha, emptyShell: false };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-client-'));
  cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
  // Driver instance is unused here because we override fetchPage.
  const driver = new PlaywrightDriver();
  client = new CodeWikiClient(driver, cache);
  fetchCalls = [];
  client.fetchPage = async (repo: string) => {
    fetchCalls.push(repo);
    if (typeof nextFetch === 'function') return (nextFetch as () => ExtractionResult)();
    return nextFetch;
  };
});

afterEach(() => {
  cache.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CodeWikiClient — cache contract', () => {
  it('cache MISS triggers a full fetch and stores the result', async () => {
    nextFetch = res();
    const r = await client.getPage('foo/bar');
    expect(fetchCalls).toEqual(['foo/bar']);
    expect('nodes' in r).toBe(true);
    // Subsequent get: should NOT re-fetch (cache HIT, fresh).
    fetchCalls = [];
    await client.getPage('foo/bar');
    expect(fetchCalls).toEqual([]);
  });

  it('cache HIT + TTL fresh returns cached body without upstream call', async () => {
    nextFetch = res('a'.repeat(40));
    await client.getPage('foo/bar');
    fetchCalls = [];

    // Sanity: simulate a SECOND get within TTL — must not call fetch.
    nextFetch = res('different-sha-would-be-served-but-wont-be-fetched');
    const r = await client.getPage('foo/bar');
    expect(fetchCalls).toEqual([]);
    expect('nodes' in r).toBe(true);
  });

  it('cache HIT + TTL expired + SAME upstream SHA → refresh fetched_at, returns CACHED nodes (not re-fetched)', async () => {
    // Prime the cache with SAMPLE_NODES + SHA 'a'*40.
    nextFetch = res('a'.repeat(40), false, SAMPLE_NODES);
    await client.getPage('foo/bar');
    const beforeFetchedAt = cache.getPage('foo/bar', '__root__')!.fetchedAt;

    // Force TTL expiry.
    const originalNow = Date.now;
    Date.now = () => originalNow() + PAGE_TTL_MS + 5_000;
    try {
      fetchCalls = [];
      // Stub returns SAME SHA but DIFFERENT nodes. If the production code
      // ignored the SHA and re-stored, the response would be the new nodes;
      // if it correctly refreshes-only, the response must be the cached nodes.
      const FRESH_NODES: CanonicalNode[] = [
        { type: 'heading', sectionSlug: 'fresh', slug: 'fresh', title: 'Fresh', level: 1, parentSlug: null, hasDiagrams: false },
        { type: 'prose', sectionSlug: 'fresh', markdown: 'this should NOT appear' },
      ];
      nextFetch = res('a'.repeat(40), false, FRESH_NODES);
      const r = await client.getPage('foo/bar');
      expect(fetchCalls).toEqual(['foo/bar']);
      expect('nodes' in r).toBe(true);

      // Locks the "no full re-extract" branch: cache body must NOT have been
      // overwritten with the fresh nodes.
      const afterCache = cache.getPage('foo/bar', '__root__')!;
      expect(afterCache.body).toEqual(SAMPLE_NODES);
      expect(afterCache.body).not.toEqual(FRESH_NODES);
      // fetched_at was bumped forward.
      expect(afterCache.fetchedAt).toBeGreaterThan(beforeFetchedAt);
    } finally {
      Date.now = originalNow;
    }
  });

  it('upstream_unavailable error from fetchPage maps to status:retry (NOT thrown)', async () => {
    const { CodeWikiError } = await import('../../src/types.js');
    client.fetchPage = async () => {
      throw new CodeWikiError('upstream_unavailable', 'simulated network failure');
    };
    const r = await client.getPage('foo/bar');
    expect('status' in r).toBe(true);
    if ('status' in r) {
      expect(r.status).toBe('retry');
      expect((r as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('getPage honours an explicit slug parameter — distinct cache rows per page', async () => {
    nextFetch = res('a'.repeat(40), false, SAMPLE_NODES);
    await client.getPage('foo/bar', 'page-a');
    await client.getPage('foo/bar', 'page-b');
    expect(cache.getPage('foo/bar', 'page-a')).not.toBeNull();
    expect(cache.getPage('foo/bar', 'page-b')).not.toBeNull();
    // A third call with no slug should hit a third cache row (__root__).
    await client.getPage('foo/bar');
    expect(cache.getPage('foo/bar', '__root__')).not.toBeNull();
  });

  it('cache HIT + TTL expired + DIFFERENT upstream SHA → invalidate and re-fetch (full)', async () => {
    nextFetch = res('a'.repeat(40));
    await client.getPage('foo/bar');
    const originalNow = Date.now;
    Date.now = () => originalNow() + PAGE_TTL_MS + 1000;
    try {
      fetchCalls = [];
      nextFetch = res('b'.repeat(40)); // DIFFERENT SHA
      const r = await client.getPage('foo/bar');
      expect(fetchCalls).toEqual(['foo/bar']);
      expect('nodes' in r).toBe(true);
      // The cache should now hold the NEW SHA.
      const stored = cache.getPage('foo/bar', '__root__');
      expect(stored?.commitSha).toBe('b'.repeat(40));
    } finally {
      Date.now = originalNow;
    }
  });

  it('probe() with notFound: returns no_wiki envelope (lean shape, no fallbacks)', async () => {
    nextFetch = res(null, true);
    const r = await client.probe('made/up');
    expect('status' in r && r.status === 'no_wiki').toBe(true);
    // The no_wiki envelope is deliberately lean — no fallbacks field.
    expect('fallbacks' in r).toBe(false);
  });

  it('listPages() with notFound: returns {repo, status:"no_wiki", pageIndex:[]}', async () => {
    nextFetch = res(null, true);
    const r = await client.listPages('made/up');
    expect(r).toEqual({ repo: 'made/up', status: 'no_wiki', pageIndex: [] });
  });

  it('getPage with a slug that does not match any heading returns status:"no_match" with availableSubsections and a fragment-free citation URL (F1)', async () => {
    // SAMPLE_NODES contains a single heading 'overview'. Calling getPage with
    // a slug that doesn't appear in the page's heading set must NOT silently
    // fall through to root content — it must return the no_match envelope.
    nextFetch = res('a'.repeat(40), false, SAMPLE_NODES);
    // RED-test runtime cast: NoMatchResult is not in the union yet, so we
    // check at runtime via a permissive record view.
    const r = (await client.getPage('foo/bar', 'slug-that-does-not-exist-zzz')) as unknown as Record<string, unknown>;
    expect(r.status).toBe('no_match');
    expect(r.repo).toBe('foo/bar');
    expect(r.slug).toBe('slug-that-does-not-exist-zzz');
    expect(r.subsection).toBe(null);
    expect(r.availableSubsections).toEqual(expect.arrayContaining(['overview']));
    const cite = r.citation as { sourceUrl: string; commitSha: string };
    expect(cite.sourceUrl).not.toContain('#');
    expect(cite.sourceUrl).toMatch(/\/github\.com\/foo\/bar$/);
    expect(cite.commitSha).toBe('a'.repeat(40));
    expect(r.reason).toMatch(/not found/i);

    // Defense-in-depth: a second call with the SAME bad slug — cache HIT path —
    // must STILL return no_match (validator runs after every fetch/cache hit,
    // not just on miss).
    fetchCalls = [];
    const r2 = (await client.getPage('foo/bar', 'slug-that-does-not-exist-zzz')) as unknown as Record<string, unknown>;
    expect(r2.status).toBe('no_match');
  });

  it('getPage with an unknown subsection returns status:"no_match" too (F1, subsection branch)', async () => {
    nextFetch = res('a'.repeat(40), false, SAMPLE_NODES);
    const r = (await client.getPage('foo/bar', undefined, 'subsection-not-real')) as unknown as Record<string, unknown>;
    expect(r.status).toBe('no_match');
    expect(r.subsection).toBe('subsection-not-real');
    const cite = r.citation as { sourceUrl: string };
    expect(cite.sourceUrl).not.toContain('#');
  });

  it('single-flight collapses concurrent calls for the same key', async () => {
    let invocations = 0;
    client.fetchPage = async () => {
      invocations++;
      await new Promise((r) => setTimeout(r, 50));
      return res();
    };
    const [a, b, c] = await Promise.all([
      client.getPage('foo/bar'),
      client.getPage('foo/bar'),
      client.getPage('foo/bar'),
    ]);
    expect(invocations).toBe(1);
    expect('nodes' in a && 'nodes' in b && 'nodes' in c).toBe(true);
  });
});
