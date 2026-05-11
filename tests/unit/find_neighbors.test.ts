/**
 * find_neighbors tool tests — verify Zod schema validation, response shape,
 * and per-kind dispatch into a stubbed GraphQuery.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  registerFindNeighbors,
  findNeighborsToolDescription,
  findNeighborsToolName,
} from '../../src/tools/find_neighbors.js';
import type { GraphQuery, GraphQueryResult } from '../../src/services/graph_query.js';

interface CallRecord {
  method: string;
  args: unknown;
}

function stubGraphQuery(result: GraphQueryResult, recorder: CallRecord[]): GraphQuery {
  const make = (method: string) => async (args: unknown): Promise<GraphQueryResult> => {
    recorder.push({ method, args });
    return result;
  };
  return {
    pagesReferencingFile: make('pagesReferencingFile'),
    diagramNeighbors: make('diagramNeighbors'),
    sectionLinks: make('sectionLinks'),
    crossRepo: make('crossRepo'),
  } as unknown as GraphQuery;
}

let server: McpServer;
let client: Client;
let calls: CallRecord[];

async function setupServer(result: GraphQueryResult): Promise<void> {
  calls = [];
  server = new McpServer({ name: 'test', version: '0.0.0' });
  registerFindNeighbors(server, { graphQuery: stubGraphQuery(result, calls) });
  client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
}

beforeEach(() => {
  calls = [];
});

describe('find_neighbors tool — metadata', () => {
  it('description is ≤ 240 chars', () => {
    expect(findNeighborsToolDescription.length).toBeLessThanOrEqual(240);
  });

  it('exposes the canonical tool name', () => {
    expect(findNeighborsToolName).toBe('find_neighbors');
  });

  it('input schema documents per-kind required co-fields via listTools()', async () => {
    await setupServer({ neighbors: [], truncated: false });
    const tools = await client.listTools();
    const entry = tools.tools.find((t) => t.name === 'find_neighbors');
    expect(entry).toBeDefined();
    const schema = entry!.inputSchema as {
      properties?: Record<string, { description?: string } | undefined>;
    };
    const kindDesc = String(schema.properties?.kind?.description ?? '');
    // The `kind` enum's description must enumerate each kind's required
    // co-fields so an MCP client / LLM can learn the per-kind contract
    // statically — without a wasted trial-and-error round-trip that surfaces
    // the runtime requireField error.
    expect(kindDesc).toMatch(/pages_referencing_file[^\n]*file_path/);
    expect(kindDesc).toMatch(/diagram_neighbors[^\n]*repo[^\n]*section_slug/);
    expect(kindDesc).toMatch(/section_links[^\n]*repo[^\n]*section_slug/);
    expect(kindDesc).toMatch(/cross_repo[^\n]*repo/);
  });
});

describe('find_neighbors tool — input validation', () => {
  it('returns isError:true for pages_referencing_file with a missing file_path', async () => {
    await setupServer({ neighbors: [], truncated: false });
    const r = await client.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'pages_referencing_file' },
    });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('returns isError:true for an unknown query.kind', async () => {
    await setupServer({ neighbors: [], truncated: false });
    const r = await client.callTool({ name: 'find_neighbors', arguments: { kind: 'whatever' } });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });
});

describe('find_neighbors tool — dispatch', () => {
  it('routes pages_referencing_file → GraphQuery.pagesReferencingFile', async () => {
    await setupServer({ neighbors: [], truncated: false });
    await client.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'pages_referencing_file', file_path: 'src/foo.ts', github_repo: 'facebook/react', limit: 5 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('pagesReferencingFile');
    expect(calls[0].args).toMatchObject({ filePath: 'src/foo.ts', githubRepo: 'facebook/react', limit: 5 });
  });

  it('routes diagram_neighbors → GraphQuery.diagramNeighbors', async () => {
    await setupServer({ neighbors: [], truncated: false });
    await client.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'diagram_neighbors', repo: 'fixture/repo', section_slug: 'core', diagram_node_id: 'n1' },
    });
    expect(calls[0].method).toBe('diagramNeighbors');
    expect(calls[0].args).toMatchObject({ repo: 'fixture/repo', sectionSlug: 'core', diagramNodeId: 'n1' });
  });

  it('routes section_links with direction', async () => {
    await setupServer({ neighbors: [], truncated: false });
    await client.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'section_links', repo: 'fixture/repo', section_slug: 'a', direction: 'in' },
    });
    expect(calls[0].method).toBe('sectionLinks');
    expect(calls[0].args).toMatchObject({ direction: 'in' });
  });

  it('routes cross_repo', async () => {
    await setupServer({ neighbors: [], truncated: false });
    await client.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'cross_repo', repo: 'A', direction: 'out' },
    });
    expect(calls[0].method).toBe('crossRepo');
  });
});

describe('find_neighbors tool — response shape', () => {
  it('forwards neighbors, truncated, status, retryAfterSeconds onto structuredContent', async () => {
    const sample: GraphQueryResult = {
      neighbors: [
        {
          kind: 'section',
          id: 'fixture/repo#core',
          edge_type: 'section_link',
          direction: 'out',
          repo: 'fixture/repo',
          citation: { sourceUrl: 'https://codewiki.google/github.com/fixture/repo#core', commitSha: 'a'.repeat(40), lastChecked: '2026-05-10T00:00:00.000Z' },
        },
      ],
      truncated: false,
    };
    await setupServer(sample);
    const r = await client.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'section_links', repo: 'fixture/repo', section_slug: 'a' },
    });
    const sc = (r as { structuredContent: { neighbors: unknown[]; truncated: boolean } }).structuredContent;
    expect(sc.neighbors).toHaveLength(1);
    expect(sc.truncated).toBe(false);
  });

  it('surfaces status=index_building without isError flag', async () => {
    await setupServer({ neighbors: [], truncated: false, status: 'index_building' });
    const r = await client.callTool({
      name: 'find_neighbors',
      arguments: { kind: 'section_links', repo: 'never/indexed', section_slug: 'a' },
    });
    const wrapped = r as { isError?: boolean; structuredContent: { status: string; neighbors: unknown[] } };
    expect(wrapped.isError).not.toBe(true);
    expect(wrapped.structuredContent.status).toBe('index_building');
    expect(wrapped.structuredContent.neighbors).toEqual([]);
  });
});
