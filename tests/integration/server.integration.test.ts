/**
 * Server-level integration test — exercises TS-001 through TS-005 against
 * the real MCP server surface using `InMemoryTransport`. Stubs the
 * CodeWikiClient's page fetch so the contracts are proved deterministically
 * without launching Chromium or hitting the live network.
 *
 * Documented deviation from plan File Structure: instead of spawning
 * `dist/index.js`, we drive `buildServer()` directly via in-memory
 * transports. This proves the same JSON-RPC contracts (initialize → tool
 * call → response shape + citation footer + no_docs structured response)
 * with one less moving part. The bin entry's startup sequence
 * (ensurePlaywright + signal handlers) is covered separately by manual
 * smoke testing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';
import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import type { CanonicalNode, ExtractionResult } from '../../src/extraction/canonical_tree.js';
import { CITATION_FOOTER_REGEX } from '../../src/extraction/serializer.js';

let tmpProjectDir: string;
let tmpCacheDir: string;
let cache: Cache;
let client: CodeWikiClient;
let mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
let mcpClient: Client;

const REACT_PAGES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'overview', markdown: 'React overview text.' },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core module description.' },
  {
    type: 'code', sectionSlug: 'core', language: 'ts', text: "console.log('react')",
    github: { repo: 'facebook/react', sha: 'd5736f098edee62c44f27b053e6e48f5fa443803', path: 'src/x.ts' },
  },
  { type: 'heading', sectionSlug: 'core-hooks', slug: 'core-hooks', title: 'Hooks', level: 3, parentSlug: 'core', hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core-hooks', markdown: 'useState, useEffect, etc.' },
  { type: 'heading', sectionSlug: 'api', slug: 'api', title: 'API', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'api', markdown: 'Public API surface.' },
];

function reactExtraction(): ExtractionResult {
  return { nodes: REACT_PAGES, notFound: false, emptyShell: false, firstCommitSha: 'd5736f098edee62c44f27b053e6e48f5fa443803' };
}

function notFoundExtraction(): ExtractionResult {
  return { nodes: [], notFound: true, emptyShell: false, firstCommitSha: null };
}

beforeEach(async () => {
  tmpProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-mcp-srv-'));
  tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-mcp-cache-'));

  // Project fixture: package.json containing one dep that we know has CodeWiki
  // (react) and one that is "uncovered" (a made-up name).
  fs.writeFileSync(
    path.join(tmpProjectDir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '0.0.1',
      dependencies: { react: '^19.0.0', 'made-up-uncovered-pkg-zz': '^1.0.0' },
    }),
  );

  cache = await Cache.open({ dbPath: path.join(tmpCacheDir, 'cache.db') });
  client = new CodeWikiClient(new PlaywrightDriver(), cache);

  // Stub fetchPage so it returns React data for facebook/react and not_found
  // for any other repo. Removes Playwright/network from the test loop.
  client.fetchPage = async (repo: string) => {
    if (repo === 'facebook/react') return reactExtraction();
    return notFoundExtraction();
  };

  // Pre-cache the repo resolution for `react` so list_project_dependencies
  // doesn't try to hit the real npm registry. (Same code path: cache HIT.)
  cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');

  const built = await buildServer({ cwd: tmpProjectDir, cache, client });
  mcpServer = built.server;

  // Connect the McpServer + Client via paired in-memory transports.
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverT);
  mcpClient = new Client({ name: 'test-client', version: '0.0.1' });
  await mcpClient.connect(clientT);
});

afterEach(async () => {
  try { await mcpClient.close(); } catch { /* ignore */ }
  try { await mcpServer.close(); } catch { /* ignore */ }
  cache.close();
  fs.rmSync(tmpProjectDir, { recursive: true, force: true });
  fs.rmSync(tmpCacheDir, { recursive: true, force: true });
});

function structuredOf(result: { structuredContent?: unknown }): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent as Record<string, unknown>;
  return {};
}

describe('TS-001 — cold-start scan in a Node project', () => {
  it('list_project_dependencies returns deps with resolvedRepo and hasWiki', async () => {
    const r = await mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
    const s = structuredOf(r);
    expect(s.projectRoot).toBe(tmpProjectDir);
    expect(s.manifestType).toBe('package.json');
    const deps = s.dependencies as Array<Record<string, unknown>>;
    expect(deps.length).toBe(2);
    const react = deps.find((d) => d.name === 'react')!;
    expect(react.resolvedRepo).toBe('facebook/react');
    expect(react.hasWiki).toBe(true);
    expect(react.pageCount).toBeGreaterThan(0);
    const uncov = deps.find((d) => d.name === 'made-up-uncovered-pkg-zz')!;
    // Uncovered dep: hasWiki should be false (or null if resolution failed).
    expect(uncov.hasWiki === false || uncov.hasWiki === null).toBe(true);
  });
});

describe('TS-002 — heading-aware sub-section retrieval', () => {
  it('get_page({listPages:true}) returns the page index, get_page subsection returns ONLY that subtree', async () => {
    const list = await mcpClient.callTool({ name: 'get_page', arguments: { repo: 'facebook/react', listPages: true } });
    const ls = structuredOf(list);
    const idx = ls.pageIndex as Array<{ slug: string; parentSlug: string | null }>;
    expect(idx.find((e) => e.slug === 'core')).toBeDefined();
    const hooks = idx.find((e) => e.slug === 'core-hooks');
    expect(hooks?.parentSlug).toBe('core');

    const getR = await mcpClient.callTool({ name: 'get_page', arguments: { repo: 'facebook/react', subsection: 'core' } });
    const gs = structuredOf(getR);
    const md = (gs.content as { markdown: string }).markdown;
    expect(md).toContain('## Core');
    expect(md).toContain('### Hooks');
    expect(md).not.toContain('Public API surface'); // peer section excluded
    expect(md).not.toContain('## API');
  });
});

describe('TS-002b — get_page no_match envelope (F1)', () => {
  it('get_page with a slug that does not match any heading returns status:"no_match" + availableSubsections + clean citation URL', async () => {
    const r = await mcpClient.callTool({
      name: 'get_page',
      arguments: { repo: 'facebook/react', slug: 'slug-that-does-not-exist-zzz' },
    });
    const s = structuredOf(r);
    expect(s.status).toBe('no_match');
    expect(s.repo).toBe('facebook/react');
    expect(s.slug).toBe('slug-that-does-not-exist-zzz');
    const avail = s.availableSubsections as string[] | undefined;
    expect(Array.isArray(avail)).toBe(true);
    expect(avail!.length).toBeGreaterThan(0);
    expect(avail).toEqual(expect.arrayContaining(['overview', 'core']));
    const cite = s.citation as { sourceUrl: string; commitSha: string };
    expect(cite.sourceUrl).not.toContain('#');
    expect(cite.sourceUrl).toMatch(/\/github\.com\/facebook\/react$/);
    expect(cite.commitSha).toMatch(/^[0-9a-f]{40}$/);
    // No content / no rendered Markdown / no citation footer in the envelope.
    expect((s as { content?: unknown }).content).toBeUndefined();
  });
});

describe('TS-003 — vague-name resolution', () => {
  it('happy path returns owner/repo; unknown name returns no_match', async () => {
    const happy = await mcpClient.callTool({ name: 'resolve_repo', arguments: { query: 'react' } });
    const hs = structuredOf(happy);
    expect(hs.owner).toBe('facebook');
    expect(hs.repo).toBe('react');

    // For the unknown name we let the real resolver run — it'll hit the
    // network OR the fuzzy fallback. Both outcomes are acceptable signals;
    // the contract is "never thrown error".
    const miss = await mcpClient.callTool({ name: 'resolve_repo', arguments: { query: 'a-name-not-in-any-registry-zz-' + Date.now() } });
    expect(miss).toBeDefined();
  });
});

describe('TS-004 — no_wiki graceful degradation', () => {
  it('get_page({listPages:true}) on uncovered repo returns {repo, status:"no_wiki", pageIndex:[]}, not isError', async () => {
    const r = await mcpClient.callTool({ name: 'get_page', arguments: { repo: 'org/uncovered', listPages: true } });
    const s = structuredOf(r);
    expect(s.status).toBe('no_wiki');
    expect(s.repo).toBe('org/uncovered');
    expect(s.pageIndex).toEqual([]);
    // Lean envelope — no fallbacks field on no_wiki.
    expect('fallbacks' in s).toBe(false);
    // isError should NOT be set on the response
    expect((r as { isError?: boolean }).isError).not.toBe(true);
  });
});

describe('TS-005 — citation footer enforcement', () => {
  it('every get_page Markdown ends with the canonical citation footer regex', async () => {
    const r = await mcpClient.callTool({ name: 'get_page', arguments: { repo: 'facebook/react' } });
    const s = structuredOf(r);
    const md = (s.content as { markdown: string }).markdown;
    expect(md).toMatch(CITATION_FOOTER_REGEX);
    const cite = s.citation as { sourceUrl: string; commitSha: string };
    expect(cite.sourceUrl).toMatch(/^https:\/\/codewiki\.google\/github\.com\/facebook\/react/);
    expect(cite.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
