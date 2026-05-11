import { describe, it, expect, beforeEach, vi } from 'vitest';

import { Cache } from '../../src/services/cache.js';
import { enrichWithBomImports } from '../../src/services/bom_resolver.js';
import { ProjectScan } from '../../src/types.js';

// Canned Spring Boot–style BOM POM with a tiny <dependencyManagement> block.
const SPRING_BOOT_BOM_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-dependencies</artifactId>
  <version>3.2.0</version>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
        <version>3.2.0</version>
      </dependency>
      <dependency>
        <groupId>org.springframework</groupId>
        <artifactId>spring-core</artifactId>
        <version>6.1.1</version>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>`;

interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

function okResponse(text: string): FetchResponseLike {
  return { ok: true, status: 200, text: async () => text };
}

function notFoundResponse(): FetchResponseLike {
  return { ok: false, status: 404, text: async () => '' };
}

async function makeCache(): Promise<Cache> {
  return Cache.open({ forceInMemory: true });
}

const SPRING_BOOT_URL =
  'https://repo1.maven.org/maven2/org/springframework/boot/spring-boot-dependencies/3.2.0/spring-boot-dependencies-3.2.0.pom';

const baseScan = (overrides: Partial<ProjectScan> = {}): ProjectScan => ({
  projectRoot: '/tmp/project',
  manifestType: 'pom.xml',
  dependencies: [],
  ...overrides,
});

describe('enrichWithBomImports', () => {
  let cache: Cache;

  beforeEach(async () => {
    cache = await makeCache();
  });

  it('returns the input scan unchanged when bomImports is empty/undefined (zero-cost fast path)', async () => {
    const scan = baseScan({
      dependencies: [
        { name: 'org.example:foo', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
    });
    const fetcher = vi.fn();
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result).toBe(scan);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches the BOM POM, persists it, and patches deps with undefined versions', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === SPRING_BOOT_URL) return okResponse(SPRING_BOOT_BOM_POM);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'org.springframework.boot:spring-boot-starter-web', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'org.springframework:spring-core', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'org.example:not-managed', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.springframework.boot', artifactId: 'spring-boot-dependencies', version: '3.2.0' },
      ],
    });

    const result = await enrichWithBomImports(scan, cache, fetcher);
    const byName = (n: string) => result.dependencies.find((d) => d.name === n);
    expect(byName('org.springframework.boot:spring-boot-starter-web')?.declaredVersion).toBe('3.2.0');
    expect(byName('org.springframework:spring-core')?.declaredVersion).toBe('6.1.1');
    expect(byName('org.example:not-managed')?.declaredVersion).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Cache populated.
    const cached = cache.getMavenBomVersions('org.springframework.boot', 'spring-boot-dependencies', '3.2.0');
    expect(cached?.versionMap).toEqual({
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
      'org.springframework:spring-core': '6.1.1',
    });
  });

  it('reads from cache on second call without invoking fetcher', async () => {
    cache.setMavenBomVersions('org.springframework.boot', 'spring-boot-dependencies', '3.2.0', {
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
    });
    const fetcher = vi.fn();
    const scan = baseScan({
      dependencies: [
        { name: 'org.springframework.boot:spring-boot-starter-web', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.springframework.boot', artifactId: 'spring-boot-dependencies', version: '3.2.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBe('3.2.0');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves explicit declaredVersion (does NOT overwrite when already set)', async () => {
    cache.setMavenBomVersions('org.springframework.boot', 'spring-boot-dependencies', '3.2.0', {
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
    });
    const fetcher = vi.fn();
    const scan = baseScan({
      dependencies: [
        { name: 'org.springframework.boot:spring-boot-starter-web', ecosystem: 'maven', declaredVersion: '2.7.0', kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.springframework.boot', artifactId: 'spring-boot-dependencies', version: '3.2.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBe('2.7.0');
  });

  it('fails soft on network error — deps stay undefined, no throw, warn-logged', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const scan = baseScan({
      dependencies: [
        { name: 'org.springframework.boot:spring-boot-starter-web', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.springframework.boot', artifactId: 'spring-boot-dependencies', version: '3.2.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails soft on 404 — deps stay undefined, no throw', async () => {
    const fetcher = vi.fn(async () => notFoundResponse());
    const scan = baseScan({
      dependencies: [
        { name: 'org.example:dep', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.example', artifactId: 'no-such-bom', version: '1.0.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBeUndefined();
  });

  it('fails soft on parse error — deps stay undefined, no throw', async () => {
    const fetcher = vi.fn(async () => okResponse('not-valid-xml-at-all'));
    const scan = baseScan({
      dependencies: [
        { name: 'org.example:dep', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.example', artifactId: 'broken-bom', version: '1.0.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBeUndefined();
  });

  it('single-flight: concurrent identical fetches collapse into one network call', async () => {
    let pending = 0;
    let observedMaxConcurrent = 0;
    const fetcher = vi.fn(async (url: string) => {
      pending += 1;
      observedMaxConcurrent = Math.max(observedMaxConcurrent, pending);
      await new Promise((r) => setTimeout(r, 20));
      pending -= 1;
      if (url === SPRING_BOOT_URL) return okResponse(SPRING_BOOT_BOM_POM);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'org.springframework.boot:spring-boot-starter-web', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.springframework.boot', artifactId: 'spring-boot-dependencies', version: '3.2.0' },
      ],
    });
    const [a, b, c] = await Promise.all([
      enrichWithBomImports(scan, cache, fetcher),
      enrichWithBomImports(scan, cache, fetcher),
      enrichWithBomImports(scan, cache, fetcher),
    ]);
    expect(a.dependencies[0].declaredVersion).toBe('3.2.0');
    expect(b.dependencies[0].declaredVersion).toBe('3.2.0');
    expect(c.dependencies[0].declaredVersion).toBe('3.2.0');
    // The single-flight invariant: at most one in-flight fetch at any moment.
    expect(observedMaxConcurrent).toBeLessThanOrEqual(1);
  });

  it('resolves property-based managed versions inside the BOM (real Spring Boot pattern)', async () => {
    const bomWithProps = `<?xml version="1.0"?><project>
      <groupId>org.example</groupId>
      <artifactId>spring-like-bom</artifactId>
      <version>3.2.0</version>
      <properties>
        <spring-framework.version>6.1.1</spring-framework.version>
        <spring.alias>\${spring-framework.version}</spring.alias>
      </properties>
      <dependencyManagement><dependencies>
        <dependency><groupId>org.springframework</groupId><artifactId>spring-core</artifactId><version>\${spring-framework.version}</version></dependency>
        <dependency><groupId>org.springframework</groupId><artifactId>spring-context</artifactId><version>\${spring.alias}</version></dependency>
        <dependency><groupId>org.example</groupId><artifactId>self-versioned</artifactId><version>\${project.version}</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const fetcher = vi.fn(async () => okResponse(bomWithProps));
    const scan = baseScan({
      dependencies: [
        { name: 'org.springframework:spring-core', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'org.springframework:spring-context', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'org.example:self-versioned', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.example', artifactId: 'spring-like-bom', version: '3.2.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    const byName = (n: string) => result.dependencies.find((d) => d.name === n);
    expect(byName('org.springframework:spring-core')?.declaredVersion).toBe('6.1.1');
    expect(byName('org.springframework:spring-context')?.declaredVersion).toBe('6.1.1'); // one-indirection
    expect(byName('org.example:self-versioned')?.declaredVersion).toBe('3.2.0'); // ${project.version}
  });

  it('recursive walk: BOM-A imports BOM-B at depth 1; BOM-B versions resolve into final patches (v2.5)', async () => {
    const bomA = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>foo</groupId><artifactId>bar</artifactId><version>1.0.0</version></dependency>
        <dependency><groupId>org.example</groupId><artifactId>bom-b</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const bomB = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>baz</groupId><artifactId>qux</artifactId><version>2.0.0</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('bom-a')) return okResponse(bomA);
      if (url.includes('bom-b')) return okResponse(bomB);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'foo:bar', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'baz:qux', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.example', artifactId: 'bom-a', version: '1.0.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    const byName = (n: string) => result.dependencies.find((d) => d.name === n);
    expect(byName('foo:bar')?.declaredVersion).toBe('1.0.0'); // depth 0
    expect(byName('baz:qux')?.declaredVersion).toBe('2.0.0'); // depth 1 (from BOM-B)
    expect(fetcher).toHaveBeenCalledTimes(2); // both BOMs fetched
  });

  it('cycle detection: A imports B; B imports A; terminates with warn-log, no hang (v2.5)', async () => {
    const bomA = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>org.example</groupId><artifactId>bom-b</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>
        <dependency><groupId>foo</groupId><artifactId>bar</artifactId><version>1.0.0</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const bomB = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>org.example</groupId><artifactId>bom-a</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>
        <dependency><groupId>baz</groupId><artifactId>qux</artifactId><version>2.0.0</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('bom-a')) return okResponse(bomA);
      if (url.includes('bom-b')) return okResponse(bomB);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'foo:bar', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'baz:qux', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.example', artifactId: 'bom-a', version: '1.0.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    const byName = (n: string) => result.dependencies.find((d) => d.name === n);
    expect(byName('foo:bar')?.declaredVersion).toBe('1.0.0');
    expect(byName('baz:qux')?.declaredVersion).toBe('2.0.0');
    // Each BOM fetched at most once even though they import each other.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('depth-cap: chain of 6 BOMs stops at MAX_BOM_DEPTH=5 with warn-log, no further fetches (v2.5)', async () => {
    // BOM-0 imports BOM-1 imports ... BOM-6. With MAX_BOM_DEPTH=5, only
    // BOM-0..BOM-5 fetch (depth 0..5); BOM-6 is rejected.
    const buildChainBom = (idx: number): string => {
      const next = idx + 1;
      const importTag =
        idx < 6
          ? `<dependency><groupId>chain</groupId><artifactId>bom-${next}</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>`
          : '';
      return `<?xml version="1.0"?><project><dependencyManagement><dependencies>
        ${importTag}
        <dependency><groupId>level</groupId><artifactId>l${idx}</artifactId><version>v${idx}</version></dependency>
      </dependencies></dependencyManagement></project>`;
    };
    const fetcher = vi.fn(async (url: string) => {
      const m = url.match(/bom-(\d+)/);
      if (!m) return notFoundResponse();
      return okResponse(buildChainBom(Number(m[1])));
    });
    const scan = baseScan({
      dependencies: [
        { name: 'level:l0', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'level:l5', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'level:l6', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [{ groupId: 'chain', artifactId: 'bom-0', version: '1.0.0' }],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    const byName = (n: string) => result.dependencies.find((d) => d.name === n);
    expect(byName('level:l0')?.declaredVersion).toBe('v0');
    expect(byName('level:l5')?.declaredVersion).toBe('v5');
    // l6 stays undefined because BOM-6 was past the depth cap and never fetched.
    expect(byName('level:l6')?.declaredVersion).toBeUndefined();
    // Fetched 6 BOMs (indices 0..5); BOM-6 is past the cap.
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('depth-precedence: depth-0 version overrides depth-1 same-coord (first-wins across depths) (v2.5)', async () => {
    const bomOuter = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>shared</groupId><artifactId>lib</artifactId><version>OUTER-1.0</version></dependency>
        <dependency><groupId>org.example</groupId><artifactId>inner-bom</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const bomInner = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>shared</groupId><artifactId>lib</artifactId><version>INNER-2.0</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('outer')) return okResponse(bomOuter);
      if (url.includes('inner')) return okResponse(bomInner);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'shared:lib', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [{ groupId: 'org.example', artifactId: 'outer-bom', version: '1.0.0' }],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBe('OUTER-1.0');
  });

  it('partial failure at depth 1 does not break sibling resolution at the same depth (v2.5)', async () => {
    const outer = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>org.example</groupId><artifactId>inner-good</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>
        <dependency><groupId>org.example</groupId><artifactId>inner-bad</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const innerGood = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>good</groupId><artifactId>lib</artifactId><version>1.0.0</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('outer')) return okResponse(outer);
      if (url.includes('inner-good')) return okResponse(innerGood);
      if (url.includes('inner-bad')) return notFoundResponse();
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'good:lib', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [{ groupId: 'org.example', artifactId: 'outer-bom', version: '1.0.0' }],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBe('1.0.0');
  });

  it('warm-cache regression: cached BOM with nested imports still walks recursively (Codex post-verify high fix)', async () => {
    // Cold call: BOM-A (cached) imports BOM-B (cached) which has the version.
    const bomA = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>org.example</groupId><artifactId>bom-b</artifactId><version>1.0.0</version><type>pom</type><scope>import</scope></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const bomB = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>only</groupId><artifactId>via-b</artifactId><version>9.9.9</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('bom-a')) return okResponse(bomA);
      if (url.includes('bom-b')) return okResponse(bomB);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'only:via-b', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [{ groupId: 'org.example', artifactId: 'bom-a', version: '1.0.0' }],
    });

    // First call: cold cache, both BOMs fetched, version resolves.
    const r1 = await enrichWithBomImports(scan, cache, fetcher);
    expect(r1.dependencies[0].declaredVersion).toBe('9.9.9');
    expect(fetcher).toHaveBeenCalledTimes(2); // BOM-A + BOM-B

    // Second call: WARM cache. Pre-bug, cache hit returned nestedBoms=[]
    // so the walker stopped at BOM-A and never enqueued BOM-B → version undefined.
    fetcher.mockClear();
    const r2 = await enrichWithBomImports(scan, cache, fetcher);
    expect(r2.dependencies[0].declaredVersion).toBe('9.9.9');
    expect(fetcher).not.toHaveBeenCalled(); // both BOMs served from cache, including nested
  });

  it('merges multiple BOMs (last wins on collision)', async () => {
    const bomA = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>foo</groupId><artifactId>bar</artifactId><version>1.0.0</version></dependency>
        <dependency><groupId>shared</groupId><artifactId>lib</artifactId><version>10.0.1</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const bomB = `<?xml version="1.0"?><project>
      <dependencyManagement><dependencies>
        <dependency><groupId>baz</groupId><artifactId>qux</artifactId><version>2.0.0</version></dependency>
        <dependency><groupId>shared</groupId><artifactId>lib</artifactId><version>20.0.1</version></dependency>
      </dependencies></dependencyManagement>
    </project>`;
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('bom-a')) return okResponse(bomA);
      if (url.includes('bom-b')) return okResponse(bomB);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'foo:bar', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'baz:qux', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'shared:lib', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      bomImports: [
        { groupId: 'org.example', artifactId: 'bom-a', version: '1.0.0' },
        { groupId: 'org.example', artifactId: 'bom-b', version: '1.0.0' },
      ],
    });
    const result = await enrichWithBomImports(scan, cache, fetcher);
    const byName = (n: string) => result.dependencies.find((d) => d.name === n);
    expect(byName('foo:bar')?.declaredVersion).toBe('1.0.0');
    expect(byName('baz:qux')?.declaredVersion).toBe('2.0.0');
    // Last-wins: bom-b overrides bom-a for shared:lib.
    expect(byName('shared:lib')?.declaredVersion).toBe('20.0.1');
  });
});
