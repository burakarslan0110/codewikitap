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

describe('v0.6 — multi-manifest + frameworks (subdir scan + framework context)', () => {
  it('polyglot cwd returns manifests[] with one entry per ecosystem root + frameworks per entry', async () => {
    // Build a polyglot tmp project: frontend/package.json + backend/pom.xml + mobile/Cargo.toml.
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-multimanifest-'));
    try {
      fs.mkdirSync(path.join(tmpProj, 'frontend'));
      fs.writeFileSync(path.join(tmpProj, 'frontend', 'package.json'), JSON.stringify({
        name: 'fe', dependencies: { next: '^15.0.0', react: '^19.0.0' },
      }));
      fs.mkdirSync(path.join(tmpProj, 'backend'));
      fs.writeFileSync(path.join(tmpProj, 'backend', 'pom.xml'),
        '<?xml version="1.0"?><project><modelVersion>4.0.0</modelVersion>' +
        '<groupId>g</groupId><artifactId>a</artifactId><version>1</version>' +
        '<dependencies><dependency><groupId>org.springframework.boot</groupId>' +
        '<artifactId>spring-boot-starter-web</artifactId><version>3.2.0</version></dependency></dependencies></project>');
      fs.mkdirSync(path.join(tmpProj, 'mobile'));
      fs.writeFileSync(path.join(tmpProj, 'mobile', 'Cargo.toml'),
        '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\ntokio = "1.37"\n');

      const ctx = await bootMcp(tmpProj, tmpCacheDir);
      try {
        // Pre-cache resolves so resolve doesn't hit the network.
        ctx.cache.setRepo('next', 'npm', 'vercel', 'next.js', 'npm-registry', 'high');
        ctx.cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
        ctx.cache.setRepo('org.springframework.boot:spring-boot-starter-web', 'maven', 'spring-projects', 'spring-boot', 'maven-central', 'high');
        ctx.cache.setRepo('tokio', 'cargo', 'tokio-rs', 'tokio', 'crates-io', 'high');

        const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
        const result = structuredOf(r);
        const manifests = result.manifests as Array<Record<string, unknown>>;
        expect(manifests).toBeDefined();
        expect(manifests.length).toBeGreaterThanOrEqual(3);
        const types = manifests.map((m) => m.manifestType as string).sort();
        expect(types).toEqual(['Cargo.toml', 'package.json', 'pom.xml']);

        // Each entry must carry a frameworks array.
        for (const m of manifests) {
          expect(Array.isArray(m.frameworks)).toBe(true);
        }

        // The pom.xml manifest must include Spring Boot framework context.
        const javaManifest = manifests.find((m) => m.manifestType === 'pom.xml')!;
        const fws = javaManifest.frameworks as Array<Record<string, unknown>>;
        const spring = fws.find((f) => f.name === 'Spring Boot');
        expect(spring).toBeDefined();
        expect(spring?.confidence).toBe('high');
        expect(spring?.sourceRepo).toBe('spring-projects/spring-boot');

        // The package.json manifest must include next.js.
        const jsManifest = manifests.find((m) => m.manifestType === 'package.json')!;
        const jsFws = jsManifest.frameworks as Array<Record<string, unknown>>;
        expect(jsFws.some((f) => f.name === 'next.js')).toBe(true);

        // manifestsTotal sums all manifests' deps; total reflects primary only.
        const manifestsTotal = result.manifestsTotal as number;
        const sumPerScan = manifests.reduce((acc, m) => acc + (m.dependencies as unknown[]).length, 0);
        expect(manifestsTotal).toBe(sumPerScan);
        expect(result.total).toBe((manifests[0].dependencies as unknown[]).length);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it('single-manifest cwd: top-level fields = primary projection of manifests[0] (legacy back-compat)', async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-singlemanifest-'));
    try {
      fs.writeFileSync(path.join(tmpProj, 'package.json'), JSON.stringify({
        name: 'x', dependencies: { lodash: '^4.0.0' },
      }));
      const ctx = await bootMcp(tmpProj, tmpCacheDir);
      try {
        ctx.cache.setRepo('lodash', 'npm', 'lodash', 'lodash', 'npm-registry', 'high');
        const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
        const result = structuredOf(r);
        const manifests = result.manifests as Array<Record<string, unknown>>;
        expect(manifests).toHaveLength(1);
        expect(result.projectRoot).toBe(manifests[0].projectRoot);
        expect(result.manifestType).toBe(manifests[0].manifestType);
        expect(result.total).toBe((manifests[0].dependencies as unknown[]).length);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it('no manifest anywhere: manifests=[], top-level projectRoot=null', async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-nomanifest-'));
    try {
      const ctx = await bootMcp(tmpProj, tmpCacheDir);
      try {
        const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
        const result = structuredOf(r);
        expect(result.manifests).toEqual([]);
        expect(result.projectRoot).toBeNull();
        expect(result.manifestType).toBeNull();
        expect(result.total).toBe(0);
        expect(result.manifestsTotal).toBe(0);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it('schema round-trip: outputSchema.parse(...) accepts the response (additive-schema smoke gate)', async () => {
    const { LIST_PROJECT_DEPENDENCIES_OUTPUT_SCHEMA } = await import('../../src/tools/list_project_dependencies.js');
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-schema-'));
    try {
      fs.writeFileSync(path.join(tmpProj, 'package.json'), JSON.stringify({
        name: 'x', dependencies: { lodash: '^4.0.0' },
      }));
      const ctx = await bootMcp(tmpProj, tmpCacheDir);
      try {
        ctx.cache.setRepo('lodash', 'npm', 'lodash', 'lodash', 'npm-registry', 'high');
        const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: {} });
        const result = structuredOf(r);
        expect(() => LIST_PROJECT_DEPENDENCIES_OUTPUT_SCHEMA.parse(result)).not.toThrow();
      } finally {
        await ctx.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });

  it('pagination applies ONLY to primary (manifests[0]); additional manifests return full deps', async () => {
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'cwk-pagination-'));
    try {
      // Two manifests, NAMED so deterministic alphabetical BFS picks the
      // multi-dep one as primary: `aaa-frontend/` (3 deps, package.json) +
      // `zzz-backend/` (1 dep, pom.xml).
      fs.mkdirSync(path.join(tmpProj, 'aaa-frontend'));
      fs.writeFileSync(path.join(tmpProj, 'aaa-frontend', 'package.json'), JSON.stringify({
        name: 'fe', dependencies: { lodash: '^4.0.0', 'date-fns': '^3.0.0', axios: '^1.0.0' },
      }));
      fs.mkdirSync(path.join(tmpProj, 'zzz-backend'));
      fs.writeFileSync(path.join(tmpProj, 'zzz-backend', 'pom.xml'),
        '<?xml version="1.0"?><project><modelVersion>4.0.0</modelVersion>' +
        '<groupId>g</groupId><artifactId>a</artifactId><version>1</version>' +
        '<dependencies><dependency><groupId>com.example</groupId><artifactId>lib</artifactId><version>1.0</version></dependency></dependencies></project>');

      const ctx = await bootMcp(tmpProj, tmpCacheDir);
      try {
        ctx.cache.setRepo('lodash', 'npm', 'lodash', 'lodash', 'npm-registry', 'high');
        ctx.cache.setRepo('date-fns', 'npm', 'date-fns', 'date-fns', 'npm-registry', 'high');
        ctx.cache.setRepo('axios', 'npm', 'axios', 'axios', 'npm-registry', 'high');
        ctx.cache.setRepo('com.example:lib', 'maven', 'example', 'lib', 'maven-central', 'high');

        const r = await ctx.mcpClient.callTool({ name: 'list_project_dependencies', arguments: { limit: 2 } });
        const result = structuredOf(r);
        const deps = result.dependencies as Array<Record<string, unknown>>;
        const manifests = result.manifests as Array<Record<string, unknown>>;
        // Primary projection paginated to 2 entries
        expect(deps).toHaveLength(2);
        // Additional manifests (pom.xml) keep full list
        const java = manifests.find((m) => m.manifestType === 'pom.xml')!;
        expect((java.dependencies as unknown[]).length).toBe(1);
        // Primary's underlying length unchanged (3); total reflects pre-slice count
        expect(result.total).toBe(3);
      } finally {
        await ctx.cleanup();
      }
    } finally {
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});
