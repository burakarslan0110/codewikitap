/**
 * find_chunks tool unit tests — assert tool registration, response shape,
 * and that index_building status flows through MCP structuredContent.
 */

import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerFindChunks, findChunksToolName } from '../../src/tools/find_chunks.js';
import type { Retriever, FindChunksResult } from '../../src/services/retriever.js';

interface RegisteredTool {
  name: string;
  config: Record<string, unknown>;
  handler: (...args: unknown[]) => Promise<unknown>;
}

function fakeServer(): { server: McpServer; tools: RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool: (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => Promise<unknown>) => {
      tools.push({ name, config, handler });
    },
  } as unknown as McpServer;
  return { server, tools };
}

function fakeRetriever(result: FindChunksResult): Retriever {
  return {
    findChunks: async (): Promise<FindChunksResult> => result,
  } as unknown as Retriever;
}

describe('registerFindChunks', () => {
  it('registers a tool named find_chunks with readOnly + idempotent annotations', () => {
    const { server, tools } = fakeServer();
    registerFindChunks(server, { retriever: fakeRetriever({ chunks: [], truncated: false }) });
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe('find_chunks');
    expect(tools[0].name).toBe(findChunksToolName);
    const ann = (tools[0].config as { annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean } }).annotations;
    expect(ann?.readOnlyHint).toBe(true);
    expect(ann?.idempotentHint).toBe(true);
  });

  it('returns chunks via structuredContent on a happy-path call', async () => {
    const sampleResult: FindChunksResult = {
      chunks: [
        {
          repo: 'facebook/react',
          pageSlug: '__root__',
          sectionSlug: 'core-hooks',
          ordinal: 0,
          score: 0.99,
          text: '# Hooks\n\nuseState.\n\n---\n*Source: ...*',
          citation: {
            sourceUrl: 'https://codewiki.google/github.com/facebook/react#core-hooks',
            commitSha: 'd5736f098edee62c44f27b053e6e48f5fa443803',
            lastChecked: new Date().toISOString(),
          },
        },
      ],
      truncated: false,
    };
    const { server, tools } = fakeServer();
    registerFindChunks(server, { retriever: fakeRetriever(sampleResult) });
    const out = (await tools[0].handler({ query: 'hooks', repo: 'facebook/react' })) as {
      structuredContent: { chunks: unknown[]; status?: string };
    };
    expect(out.structuredContent.chunks.length).toBe(1);
    expect(out.structuredContent.status).toBeUndefined();
  });

  it('surfaces status=index_building when retriever returns it', async () => {
    const { server, tools } = fakeServer();
    registerFindChunks(server, {
      retriever: fakeRetriever({ chunks: [], truncated: false, status: 'index_building' }),
    });
    const out = (await tools[0].handler({ query: 'q', repo: 'r' })) as {
      structuredContent: { chunks: unknown[]; status?: string };
    };
    expect(out.structuredContent.status).toBe('index_building');
    expect(out.structuredContent.chunks).toEqual([]);
  });

  it('clamps k to [1, 32]', async () => {
    let observedK: number | undefined;
    const r = {
      findChunks: async (_q: string, _repo: string | undefined, k: number): Promise<FindChunksResult> => {
        observedK = k;
        return { chunks: [], truncated: false };
      },
    } as unknown as Retriever;
    const { server, tools } = fakeServer();
    registerFindChunks(server, { retriever: r });
    await tools[0].handler({ query: 'q', k: 1000 });
    expect(observedK).toBe(32);
    await tools[0].handler({ query: 'q', k: 0 });
    expect(observedK).toBe(1);
  });
});
