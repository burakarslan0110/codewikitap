/**
 * request_indexing (v2.6 — 7th MCP tool) unit tests.
 *
 * Locks the sync-race contract (same UX as find_chunks): build wins → ready;
 * timeout → index_building; passes through no_docs / rate_limited / retry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { registerRequestIndexing } from '../../src/tools/request_indexing.js';
import type { Indexer, IndexerResult } from '../../src/services/indexer.js';

let server: McpServer;
let client: Client;

async function setupServer(
  indexer: Pick<Indexer, 'indexRepo'>,
  timeoutMs?: number,
): Promise<void> {
  server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: {} });
  registerRequestIndexing(server, { indexer }, timeoutMs !== undefined ? { timeoutMs } : {});
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
}

function call(repo: string): Promise<unknown> {
  return client.callTool({ name: 'request_indexing', arguments: { repo } });
}

interface CallResult {
  structuredContent?: {
    repo: string;
    status: 'ready' | 'index_building' | 'no_docs' | 'rate_limited' | 'retry';
    chunkCount?: number;
    edgeCount?: number;
    retryAfterSeconds?: number;
    fallbacks?: Array<{ kind: string; url?: string }>;
    reason?: string;
  };
  isError?: boolean;
}

beforeEach(() => {
  // Setup happens per-test below.
});

describe('request_indexing — sync race contract', () => {
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

  it('returns status=index_building on timeout; in-flight build continues', async () => {
    let resolveBuild!: (r: IndexerResult) => void;
    const buildPromise = new Promise<IndexerResult>((resolve) => { resolveBuild = resolve; });
    await setupServer({ indexRepo: () => buildPromise }, 50);
    const r = (await call('nodejs/node')) as CallResult;
    expect(r.structuredContent?.status).toBe('index_building');
    expect(r.structuredContent?.repo).toBe('nodejs/node');
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

  it('catches synchronous indexer.indexRepo throw and returns status=retry', async () => {
    await setupServer({
      indexRepo: () => { throw new Error('synchronous indexer failure'); },
    });
    const r = (await call('x/y')) as CallResult;
    expect(r.structuredContent?.status).toBe('retry');
    expect(r.structuredContent?.reason).toContain('synchronous indexer failure');
  });

  it('rejects malformed repo arg (non-canonical shape)', async () => {
    await setupServer({
      indexRepo: async (): Promise<IndexerResult> => ({ status: 'ready', chunkCount: 0, edgeCount: 0 }),
    });
    const r = (await call('just-one-segment')) as CallResult;
    expect(r.isError).toBe(true);
  });
});
