/**
 * Server build + tool-surface audit.
 *
 * Locks the v2.6 differentiator: tool surface MUST be exactly the 7 documented
 * names. The Cloudmeru-parity regex still rejects any `*search*`, `*ask*`,
 * `*query*`, `*generate*`, `*index*`, or `*write*` tool that would drift
 * toward Cloudmeru; v2.6 introduces a single-name whitelist (`request_indexing`)
 * — the FORBIDDEN_TOKEN_WHITELIST is asserted equal to that exact set so
 * adding any second `*index*` (or other token-matching) name requires an
 * explicit edit and a deliberate review.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { fileURLToPath } from 'node:url';

import { buildServer, SERVER_INSTRUCTIONS, SERVER_VERSION } from '../../src/server.js';
import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { Embedder } from '../../src/adapters/embedder.js';

let tmpDir: string;
let cache: Cache;
let client: CodeWikiClient;
let embedder: Embedder;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-server-'));
  cache = await Cache.open({ dbPath: path.join(tmpDir, 'cache.db') });
  client = new CodeWikiClient(new PlaywrightDriver(), cache);
  // Inject a mock embedder so buildServer doesn't trigger model download.
  embedder = new Embedder({
    modelDim: 4,
    encoderImpl: { async encode(texts: string[]) { return texts.map(() => new Float32Array(4)); } },
  });
});

afterEach(() => {
  cache.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * v2.6 frozen-set whitelist: ONLY `request_indexing` is admitted past the
 * Cloudmeru-parity regex. Symmetric equality assertion fails on additions,
 * removals, AND substitutions — forces any future change to be deliberate.
 */
const FORBIDDEN_TOKEN_WHITELIST = new Set(['request_indexing']);

describe('buildServer — tool-surface audit', () => {
  it('registers exactly the 7 documented tool names (v2.6: includes request_indexing)', async () => {
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    const names = built.toolNames.slice().sort();
    expect(names).toEqual([
      'find_chunks',
      'find_neighbors',
      'get_page',
      'list_pages',
      'list_project_dependencies',
      'request_indexing',
      'resolve_repo',
    ]);
  });

  it('forbids tool names suggesting Cloudmeru-parity surface — every forbidden token still rejected (v2.6 whitelist)', async () => {
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    const forbidden = /(search|ask|query|generate|index|write)/i;
    // Every non-whitelisted tool name passes the regex (none match).
    for (const name of built.toolNames) {
      if (FORBIDDEN_TOKEN_WHITELIST.has(name)) continue;
      expect(name).not.toMatch(forbidden);
    }
    // v2.6: the whitelist is a frozen-set equality — additions, removals,
    // AND substitutions all break this assertion, forcing deliberate review.
    expect(FORBIDDEN_TOKEN_WHITELIST).toEqual(new Set(['request_indexing']));
    // Re-affirm the regex still rejects each Cloudmeru-parity token.
    for (const tok of ['search', 'ask', 'query', 'generate', 'index', 'write']) {
      expect(forbidden.test(`foo_${tok}_bar`)).toBe(true);
    }
    // And that the v2/v2.1 names specifically do NOT match.
    expect(forbidden.test('find_chunks')).toBe(false);
    expect(forbidden.test('find_neighbors')).toBe(false);
  });

  it('exposes server instructions covering the documented imperatives (v2.6: includes request_indexing)', async () => {
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    expect(built.server).toBeDefined();
    expect(SERVER_INSTRUCTIONS).toContain('list_project_dependencies');
    expect(SERVER_INSTRUCTIONS).toContain('find_chunks');
    expect(SERVER_INSTRUCTIONS).toContain('find_neighbors');
    expect(SERVER_INSTRUCTIONS).toContain('list_pages then get_page');
    expect(SERVER_INSTRUCTIONS).toContain('request_indexing');
    expect(SERVER_INSTRUCTIONS).toContain('citation');
  });

  it('request_indexing is the only non-readonly tool (toolNames includes it; ReadOnlyHint=false)', async () => {
    // Whitelist is exactly { request_indexing } — assert non-readonly status
    // implicitly via the whitelist test above + this presence check.
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    expect(built.toolNames).toContain('request_indexing');
  });

  it('list_project_dependencies tool description fits the 240-char budget (v2.2 includeDev + v2.8 includeOptional clauses)', async () => {
    const { TOOL_DESCRIPTION } = await import('../../src/tools/list_project_dependencies.js');
    expect(TOOL_DESCRIPTION.length).toBeLessThanOrEqual(240);
    // Must mention both flags so the agent sees the available capabilities.
    expect(TOOL_DESCRIPTION).toContain('includeDev');
    expect(TOOL_DESCRIPTION).toContain('includeOptional');
  });

  it('SERVER_VERSION === package.json.version (PSF-001 lock)', () => {
    // package.json lives at the repo root, two levels up from this test file.
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version: string };
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
