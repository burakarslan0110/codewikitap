/**
 * get_page({ prepareOnly: true }) unit tests (v0.7 — replaces the v0.6
 * request_indexing.test.ts).
 *
 * Locks the sync-race contract (same UX as find_chunks): build wins → ready;
 * timeout → index_building; passes through no_docs / rate_limited / retry.
 * Envelope shape is byte-equal to what the v0.6 request_indexing tool used
 * to return — agents migrating from request_indexing(repo) to
 * get_page({ repo, prepareOnly: true }) need no other change.
 */

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerGetPage } from '../../src/tools/get_page.js';
import type { Indexer, IndexerResult } from '../../src/services/indexer.js';
import type { CodeWikiClient } from '../../src/services/codewiki_client.js';

let server: McpServer;
let client: Client;

async function setupServer(
  indexer: Pick<Indexer, 'indexRepo'> & { estimateRemainingMs?: (elapsedMs: number) => number },
  prepareTimeoutMs?: number,
): Promise<void> {
  server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  // CodeWikiClient is unused on the prepareOnly path — pass a tagged stub so
  // any accidental access surfaces immediately.
  const clientStub = {
    listPages: () => { throw new Error('listPages should not be called on prepareOnly path'); },
    getPage: () => { throw new Error('getPage should not be called on prepareOnly path'); },
  } as unknown as CodeWikiClient;
  // Default estimate stub returns 0 (cold-path) when caller does not provide one.
  const fullIndexer = {
    indexRepo: indexer.indexRepo,
    estimateRemainingMs: indexer.estimateRemainingMs ?? ((_elapsed: number) => 0),
  };
  registerGetPage(
    server,
    { client: clientStub, indexer: fullIndexer as unknown as Pick<Indexer, 'indexRepo' | 'estimateRemainingMs'> },
    prepareTimeoutMs !== undefined ? { prepareTimeoutMs } : {},
  );
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
}

function call(repo: string): Promise<unknown> {
  return client.callTool({ name: 'get_page', arguments: { repo, prepareOnly: true } });
}

interface CallResult {
  structuredContent?: {
    repo: string;
    status: 'ready' | 'index_building' | 'no_docs' | 'rate_limited' | 'retry';
    chunkCount?: number;
    edgeCount?: number;
    retryAfterSeconds?: number;
    estimatedRemainingSeconds?: number;
    fallbacks?: Array<{ kind: string; url?: string }>;
    reason?: string;
  };
  isError?: boolean;
}

describe('get_page({ prepareOnly: true }) — sync race contract', () => {
  it('returns status=ready with chunkCount + edgeCount when build wins the race', async () => {
    await setupServer({
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'ready', chunkCount: 12, edgeCount: 7 }),
    });
    const r = (await call('facebook/react')) as CallResult;
    expect(r.isError).not.toBe(true);
    expect(r.structuredContent?.repo).toBe('facebook/react');
    expect(r.structuredContent?.status).toBe('ready');
    expect(r.structuredContent?.chunkCount).toBe(12);
    expect(r.structuredContent?.edgeCount).toBe(7);
  });

  it('returns status=index_building on timeout; in-flight build continues; surfaces estimatedRemainingSeconds', async () => {
    let resolveBuild!: (r: IndexerResult) => void;
    const buildPromise = new Promise<IndexerResult>((resolve) => { resolveBuild = resolve; });
    await setupServer(
      {
        indexRepo: () => buildPromise,
        // Rolling-window estimate: avg 8000 ms; after ~50 ms elapsed, expect
        // remaining ≈ 7950 ms → ceil(7.95) = 8 seconds.
        estimateRemainingMs: (elapsed: number) => Math.max(0, 8000 - elapsed),
      },
      50,
    );
    const r = (await call('nodejs/node')) as CallResult;
    expect(r.structuredContent?.status).toBe('index_building');
    expect(r.structuredContent?.repo).toBe('nodejs/node');
    // estimatedRemainingSeconds present and numeric (>=0). Exact value is
    // race-window-dependent (50 ms timeout + a few ms scheduling slop), so
    // assert the range rather than the precise value.
    expect(typeof r.structuredContent?.estimatedRemainingSeconds).toBe('number');
    expect(r.structuredContent?.estimatedRemainingSeconds).toBeGreaterThanOrEqual(0);
    expect(r.structuredContent?.estimatedRemainingSeconds).toBeLessThanOrEqual(8);
    // Resolve the in-flight build for clean teardown.
    resolveBuild({ status: 'ready', chunkCount: 0, edgeCount: 0 });
  });

  it('passes through no_docs with fallbacks', async () => {
    const fallbacks = [{ kind: 'github_readme' as const, url: 'https://github.com/x/y' }];
    await setupServer({
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'no_docs', fallbacks }),
    });
    const r = (await call('x/y')) as CallResult;
    expect(r.structuredContent?.status).toBe('no_docs');
    expect(r.structuredContent?.fallbacks).toEqual(fallbacks);
  });

  it('passes through rate_limited with retryAfterSeconds', async () => {
    await setupServer({
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'rate_limited', retryAfterSeconds: 4 }),
    });
    const r = (await call('x/y')) as CallResult;
    expect(r.structuredContent?.status).toBe('rate_limited');
    expect(r.structuredContent?.retryAfterSeconds).toBe(4);
  });

  it('passes through retry with reason', async () => {
    await setupServer({
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'retry', retryAfterSeconds: 30, reason: 'transient' }),
    });
    const r = (await call('x/y')) as CallResult;
    expect(r.structuredContent?.status).toBe('retry');
    expect(r.structuredContent?.retryAfterSeconds).toBe(30);
    expect(r.structuredContent?.reason).toBe('transient');
  });

  it('rejects calls passing BOTH prepareOnly:true AND listPages:true (mutex)', async () => {
    await setupServer({
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'ready', chunkCount: 0, edgeCount: 0 }),
    });
    const r = (await client.callTool({
      name: 'get_page',
      arguments: { repo: 'x/y', prepareOnly: true, listPages: true },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(r.isError).toBe(true);
    const text = r.content?.[0]?.text ?? '';
    expect(text).toContain('mutually exclusive');
  });

  it('catches synchronous indexer.indexRepo throw and returns status=retry', async () => {
    await setupServer({
      indexRepo: () => { throw new Error('synchronous indexer failure'); },
    });
    const r = (await call('x/y')) as CallResult;
    expect(r.structuredContent?.status).toBe('retry');
    expect(r.structuredContent?.reason).toContain('synchronous indexer failure');
  });
});
