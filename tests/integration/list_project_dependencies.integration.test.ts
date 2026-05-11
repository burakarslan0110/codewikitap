/**
 * v2.4 list_project_dependencies — MCP-roundtrip integration tests.
 *
 * Boots the real `buildServer()` over `InMemoryTransport` and exercises the
 * v2.4 manifest paths end-to-end: Maven aggregator + BOM-resolved versions,
 * .sln top-level dispatch, .sln csproj-branch upward walk, go.work workspace,
 * Gradle settings.gradle subproject discovery, declaredVersion surfacing in
 * tool output, and the 6-tool surface lock with no v2.4 additions.
 *
 * Repo resolution is short-circuited by pre-populating `cache.repos` so the
 * tool never hits npm/Maven Central/Packagist live. CodeWiki page fetch is
 * stubbed to `notFoundExtraction` for every repo (we don't need wiki coverage
 * for these scenarios — the contract under test is the manifest layer).
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
import type { ExtractionResult } from '../../src/extraction/canonical_tree.js';

const FIXTURES = path.resolve(__dirname, '../fixtures/manifests');

interface BootContext {
  cache: Cache;
  client: CodeWikiClient;
  mcpServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
  mcpClient: Client;
  cleanup: () => Promise<void>;
}

function notFoundExtraction(): ExtractionResult {
  return { nodes: [], notFound: true, emptyShell: false, firstCommitSha: null };
}

async function bootMcp(cwd: string, tmpCacheDir: string): Promise<BootContext> {
  const cache = await Cache.open({ dbPath: path.join(tmpCacheDir, 'cache.db') });
  const client = new CodeWikiClient(new PlaywrightDriver(), cache);
  client.fetchPage = async () => notFoundExtraction();

  const built = await buildServer({ cwd, cache, client });
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverT);
  const mcpClient = new Client({ name: 'v2.4-test-client', version: '0.0.1' });
  await mcpClient.connect(clientT);

  return {
    cache,
    client,
    mcpServer: built.server,
    mcpClient,
    cleanup: async () => {
      try { await mcpClient.close(); } catch { /* ignore */ }
      try { await built.server.close(); } catch { /* ignore */ }
      cache.close();
    },
  };
}

function structuredOf(r: { structuredContent?: unknown }): Record<string, unknown> {
  return (r.structuredContent ?? {}) as Record<string, unknown>;
}

let tmpCacheDir: string;

beforeEach(() => {
  tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-v24-cache-'));
});

afterEach(() => {
  fs.rmSync(tmpCacheDir, { recursive: true, force: true });
});

describe('v2.4 — TS-001/TS-003: Maven aggregator-pom', () => {
  it('list_project_dependencies aggregates module deps and surfaces workspaceMembers', async () => {
    const ctx = await bootMcp(path.join(FIXTURES, 'aggregator-pom-multi'), tmpCacheDir);
    try {
      // Pre-cache resolutions so resolveAndProbe doesn't hit Maven Central.
      ctx.cache.setRepo('com.google.guava:guava', 'maven', 'google', 'guava', 'maven-central', 'high');
      ctx.cache.setRepo('org.springframework:spring-core', 'maven', 'spring-projects', 'spring-framework', 'maven-central', 'high');
      ctx.cache.setRepo('com.fasterxml.jackson.core:jackson-databind', 'maven', 'FasterXML', 'jackson-databind', 'maven-central', 'high');

      const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
      const result = structuredOf(r);

      expect(result.manifestType).toBe('pom.xml');
      const deps = result.dependencies as Array<Record<string, unknown>>;
      const names = deps.map((d) => d.name as string).sort();
      expect(names).toEqual([
        'com.fasterxml.jackson.core:jackson-databind',
        'com.google.guava:guava',
        'org.springframework:spring-core',
      ]);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('v2.4 — TS-002: Spring Boot BOM-resolved versions surface in tool output', () => {
  it('declaredVersion patched from cached BOM map appears in dependencies[].declaredVersion', async () => {
    const ctx = await bootMcp(path.join(FIXTURES, 'pom-with-bom-import-spring.xml').replace(/[^/]+$/, ''), tmpCacheDir);
    // The fixture is a single-file pom; we need a directory for the tool's
    // cwd. Build a tiny tmp dir and copy the fixture into it.
    await ctx.cleanup();

    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-v24-bomdir-'));
    try {
      fs.copyFileSync(
        path.join(FIXTURES, 'pom-with-bom-import-spring.xml'),
        path.join(tmpProj, 'pom.xml'),
      );

      const ctx2 = await bootMcp(tmpProj, tmpCacheDir);
      try {
        // Pre-populate BOM cache so enrichWithBomImports never fetches.
        ctx2.cache.setMavenBomVersions(
          'org.springframework.boot',
          'spring-boot-dependencies',
          '3.2.0',
          { 'org.springframework.boot:spring-boot-starter-web': '3.2.0' },
        );
        ctx2.cache.setRepo(
          'org.springframework.boot:spring-boot-starter-web',
          'maven',
          'spring-projects',
          'spring-boot',
          'maven-central',
          'high',
        );

        const r = await ctx2.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
        const result = structuredOf(r);
        const deps = result.dependencies as Array<Record<string, unknown>>;
        const sbStarter = deps.find((d) => d.name === 'org.springframework.boot:spring-boot-starter-web');
        expect(sbStarter).toBeDefined();
        expect(sbStarter?.declaredVersion).toBe('3.2.0');
      } finally {
        await ctx2.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});

describe('v2.4 — TS-013: .sln solution-root cwd dispatches via top-level priority entry', () => {
  it('cwd = solution root with no *.csproj at root resolves to merged sln-listed deps; manifestType=sln', async () => {
    const ctx = await bootMcp(path.join(FIXTURES, 'sln-with-csprojs'), tmpCacheDir);
    try {
      ctx.cache.setRepo('Microsoft.Extensions.Logging', 'nuget', 'dotnet', 'extensions', 'nuget', 'high');
      ctx.cache.setRepo('Newtonsoft.Json', 'nuget', 'JamesNK', 'Newtonsoft.Json', 'nuget', 'high');

      const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
      const result = structuredOf(r);
      expect(result.manifestType).toBe('sln');
      const deps = result.dependencies as Array<Record<string, unknown>>;
      const names = deps.map((d) => d.name as string).sort();
      expect(names).toEqual(['Microsoft.Extensions.Logging', 'Newtonsoft.Json']);
    } finally {
      await ctx.cleanup();
    }
  });

  it('declaredVersion field surfaces in tool output for csproj PackageReferences', async () => {
    const ctx = await bootMcp(path.join(FIXTURES, 'sln-with-csprojs'), tmpCacheDir);
    try {
      ctx.cache.setRepo('Microsoft.Extensions.Logging', 'nuget', 'dotnet', 'extensions', 'nuget', 'high');
      ctx.cache.setRepo('Newtonsoft.Json', 'nuget', 'JamesNK', 'Newtonsoft.Json', 'nuget', 'high');

      const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
      const result = structuredOf(r);
      const deps = result.dependencies as Array<Record<string, unknown>>;
      const log = deps.find((d) => d.name === 'Microsoft.Extensions.Logging');
      const json = deps.find((d) => d.name === 'Newtonsoft.Json');
      expect(log?.declaredVersion).toBe('8.0.0');
      expect(json?.declaredVersion).toBe('13.0.3');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('v2.4 — TS-006: go.work workspace via MCP roundtrip', () => {
  it('cwd = go.work root aggregates per-member go.mod deps; manifestType=go.work', async () => {
    const ctx = await bootMcp(path.join(FIXTURES, 'go-work-workspace'), tmpCacheDir);
    try {
      // Pre-cache so tool doesn't hit go-proxy.
      ctx.cache.setRepo('github.com/foo/bar', 'go', 'foo', 'bar', 'go-proxy', 'high');
      ctx.cache.setRepo('github.com/baz/qux', 'go', 'baz', 'qux', 'go-proxy', 'high');
      ctx.cache.setRepo('github.com/shared/lib', 'go', 'shared', 'lib', 'go-proxy', 'high');

      const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
      const result = structuredOf(r);
      expect(result.manifestType).toBe('go.work');
      const deps = result.dependencies as Array<Record<string, unknown>>;
      const names = deps.map((d) => d.name as string).sort();
      expect(names).toEqual([
        'github.com/baz/qux',
        'github.com/foo/bar',
        'github.com/shared/lib',
      ]);
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('v2.4 — TS-007: Gradle settings.gradle subproject discovery via MCP', () => {
  it('cwd = gradle multi-module root surfaces deps from libs.versions.toml only (no DSL parsing)', async () => {
    const ctx = await bootMcp(path.join(FIXTURES, 'gradle-multi-module'), tmpCacheDir);
    try {
      ctx.cache.setRepo('org.springframework:spring-core', 'maven', 'spring-projects', 'spring-framework', 'maven-central', 'high');
      const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
      const result = structuredOf(r);
      expect(result.manifestType).toBe('libs.versions.toml');
      const deps = result.dependencies as Array<Record<string, unknown>>;
      // Only the catalog-declared dep — no DSL-parsed extras.
      expect(deps).toHaveLength(1);
      expect(deps[0].name).toBe('org.springframework:spring-core');
    } finally {
      await ctx.cleanup();
    }
  });
});

describe('v2.6 — TS-009: 7-tool surface lock (request_indexing added)', () => {
  it('tools/list returns exactly the canonical v1+v2+v2.1+v2.6 tool set', async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-v24-tools-'));
    fs.writeFileSync(path.join(tmpProj, 'package.json'), '{}');
    try {
      const ctx = await bootMcp(tmpProj, tmpCacheDir);
      try {
        const list = await ctx.mcpClient.listTools();
        const names = list.tools.map((t) => t.name).sort();
        expect(names).toEqual([
          'find_chunks',
          'find_neighbors',
          'get_page',
          'list_pages',
          'list_project_dependencies',
          'request_indexing',
          'resolve_repo',
        ]);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});

describe('v2.4 — TS-008: BOM resolver fail-soft when cache is empty AND fetch fails', () => {
  it('tool returns deps with declaredVersion=undefined when no BOM cache and network is unavailable (fail-soft)', async () => {
    // Fail-soft test: don't pre-populate the BOM cache; rely on the
    // bom_resolver's catch-all to keep deps undefined.
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-v24-failsoft-'));
    try {
      fs.copyFileSync(
        path.join(FIXTURES, 'pom-with-bom-import-spring.xml'),
        path.join(tmpProj, 'pom.xml'),
      );

      const ctx = await bootMcp(tmpProj, tmpCacheDir);
      try {
        ctx.cache.setRepo(
          'org.springframework.boot:spring-boot-starter-web',
          'maven',
          'spring-projects',
          'spring-boot',
          'maven-central',
          'high',
        );
        // Stub global fetch to reject — simulates offline.
        const originalFetch = global.fetch;
        global.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
        try {
          const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
          const result = structuredOf(r);
          const deps = result.dependencies as Array<Record<string, unknown>>;
          const starter = deps.find((d) => d.name === 'org.springframework.boot:spring-boot-starter-web');
          expect(starter).toBeDefined();
          expect(starter?.declaredVersion).toBeUndefined();
        } finally {
          global.fetch = originalFetch;
        }
      } finally {
        await ctx.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});
