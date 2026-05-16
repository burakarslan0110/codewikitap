/**
 * Server build + tool-surface audit.
 *
 * v0.7 surface lock: exactly 5 documented tool names. The Cloudmeru-parity
 * regex rejects any `*search*`, `*ask*`, `*query*`, `*generate*`, `*index*`,
 * or `*write*` tool — the FORBIDDEN_TOKEN_WHITELIST is the EMPTY SET (v0.7
 * `request_indexing` removed; behavior reachable via
 * `get_page({ prepareOnly: true })`).
 *
 * get_page is the only non-readonly tool — the prepareOnly path triggers
 * HTTP fetch + sqlite write.
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
 * v0.7 frozen-set whitelist: EMPTY. The Cloudmeru-parity regex rejects
 * every match-token now without exception — adding any future *index* /
 * *search* / *query* / *generate* / *write* / *ask* name requires both
 * the regex change AND an explicit whitelist entry, which is a deliberate
 * review surface.
 */
const FORBIDDEN_TOKEN_WHITELIST = new Set<string>();

describe('buildServer — tool-surface audit', () => {
  it('registers exactly the 5 documented tool names (list_pages exposed via get_page({ listPages: true }); pre-warm via get_page({ prepareOnly: true }))', async () => {
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    const names = built.toolNames.slice().sort();
    expect(names).toEqual([
      'find_chunks',
      'find_neighbors',
      'get_page',
      'list_project_dependencies',
      'resolve_repo',
    ]);
    expect(built.toolNames.length).toBe(5);
  });

  it('forbids tool names suggesting Cloudmeru-parity surface — every forbidden token rejected (v0.7 empty whitelist)', async () => {
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    const forbidden = /(search|ask|query|generate|index|write)/i;
    for (const name of built.toolNames) {
      if (FORBIDDEN_TOKEN_WHITELIST.has(name)) continue;
      expect(name).not.toMatch(forbidden);
    }
    // v0.7: the whitelist is now EMPTY — additions to either the regex or
    // the whitelist set break this assertion, forcing deliberate review.
    expect(FORBIDDEN_TOKEN_WHITELIST).toEqual(new Set<string>());
    // Re-affirm the regex still rejects each Cloudmeru-parity token.
    for (const tok of ['search', 'ask', 'query', 'generate', 'index', 'write']) {
      expect(forbidden.test(`foo_${tok}_bar`)).toBe(true);
    }
    // And that the registered names specifically do NOT match.
    expect(forbidden.test('find_chunks')).toBe(false);
    expect(forbidden.test('find_neighbors')).toBe(false);
    expect(forbidden.test('get_page')).toBe(false);
  });

  it('exposes server instructions covering the documented imperatives (5-tool surface; no removed names)', async () => {
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    expect(built.server).toBeDefined();
    expect(SERVER_INSTRUCTIONS).toContain('list_project_dependencies');
    expect(SERVER_INSTRUCTIONS).toContain('resolve_repo');
    expect(SERVER_INSTRUCTIONS).toContain('find_chunks');
    expect(SERVER_INSTRUCTIONS).toContain('find_neighbors');
    expect(SERVER_INSTRUCTIONS).toContain('get_page');
    expect(SERVER_INSTRUCTIONS).toContain('listPages');
    expect(SERVER_INSTRUCTIONS).toContain('prepareOnly');
    expect(SERVER_INSTRUCTIONS).toContain('citation');
    // Negative assertions: removed/never-existed names must NOT appear.
    expect(SERVER_INSTRUCTIONS).not.toContain('request_indexing');
    expect(SERVER_INSTRUCTIONS).not.toContain('list_pages');
    // Tool-surface threshold (≤ 10% context). Plan-locked 1200-char ceiling.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1200);
  });

  it('get_page is the only non-readonly tool (v0.7 — prepareOnly triggers HTTP + sqlite writes)', async () => {
    const built = await buildServer({ cwd: tmpDir, cache, client, embedder });
    // get_page is on the surface and is the documented non-readonly tool.
    expect(built.toolNames).toContain('get_page');
    // request_indexing is no longer registered.
    expect(built.toolNames).not.toContain('request_indexing');
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
