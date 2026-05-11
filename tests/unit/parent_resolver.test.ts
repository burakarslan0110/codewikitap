import { describe, it, expect, beforeEach, vi } from 'vitest';

import { Cache } from '../../src/services/cache.js';
import { enrichWithParentPom } from '../../src/services/parent_resolver.js';
import { ProjectScan } from '../../src/types.js';

const SPRING_BOOT_STARTER_PARENT_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-parent</artifactId>
  <version>3.2.0</version>
  <packaging>pom</packaging>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>3.2.0</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>`;

const PARENT_WITH_LITERAL_DM_POM = `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>my-parent</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>foo</artifactId>
        <version>1.2.3</version>
      </dependency>
      <dependency>
        <groupId>com.example</groupId>
        <artifactId>bar</artifactId>
        <version>4.5.6</version>
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

const SPRING_BOOT_PARENT_URL =
  'https://repo1.maven.org/maven2/org/springframework/boot/spring-boot-starter-parent/3.2.0/spring-boot-starter-parent-3.2.0.pom';

const MY_PARENT_URL =
  'https://repo1.maven.org/maven2/com/example/my-parent/1.0.0/my-parent-1.0.0.pom';

const baseScan = (overrides: Partial<ProjectScan> = {}): ProjectScan => ({
  projectRoot: '/tmp/project',
  manifestType: 'pom.xml',
  dependencies: [],
  ...overrides,
});

describe('enrichWithParentPom', () => {
  let cache: Cache;

  beforeEach(async () => {
    cache = await makeCache();
  });

  it('returns the input scan unchanged when parentCoords is undefined (zero-cost fast path)', async () => {
    const scan = baseScan({
      dependencies: [
        { name: 'org.example:foo', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
    });
    const fetcher = vi.fn();
    const result = await enrichWithParentPom(scan, cache, fetcher);
    expect(result).toBe(scan);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('patches deps from parent literal <dependencyManagement> versions', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === MY_PARENT_URL) return okResponse(PARENT_WITH_LITERAL_DM_POM);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        { name: 'com.example:foo', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'com.example:bar', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
        { name: 'com.example:not-managed', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      parentCoords: { groupId: 'com.example', artifactId: 'my-parent', version: '1.0.0' },
    });

    const result = await enrichWithParentPom(scan, cache, fetcher);
    const byName = (n: string) => result.dependencies.find((d) => d.name === n);
    expect(byName('com.example:foo')?.declaredVersion).toBe('1.2.3');
    expect(byName('com.example:bar')?.declaredVersion).toBe('4.5.6');
    expect(byName('com.example:not-managed')?.declaredVersion).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);

    const cached = cache.getMavenParentVersions('com.example', 'my-parent', '1.0.0');
    expect(cached?.versionMap).toEqual({
      'com.example:foo': '1.2.3',
      'com.example:bar': '4.5.6',
    });
  });

  it("appends parent's nested <scope>import</scope> BOMs onto scan.bomImports (Codex high fix #3)", async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url === SPRING_BOOT_PARENT_URL) return okResponse(SPRING_BOOT_STARTER_PARENT_POM);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        {
          name: 'org.springframework.boot:spring-boot-starter-web',
          ecosystem: 'maven',
          declaredVersion: undefined,
          kind: 'runtime',
        },
      ],
      parentCoords: {
        groupId: 'org.springframework.boot',
        artifactId: 'spring-boot-starter-parent',
        version: '3.2.0',
      },
    });

    const result = await enrichWithParentPom(scan, cache, fetcher);

    expect(result.bomImports).toBeDefined();
    expect(result.bomImports).toContainEqual({
      groupId: 'org.springframework.boot',
      artifactId: 'spring-boot-dependencies',
      version: '3.2.0',
    });
    // Parent had no LITERAL DM versions — only the BOM import — so deps stay
    // undefined at this stage. The BOM walker (enrichWithBomImports) running
    // AFTER parent_resolver picks up scan.bomImports including the appended
    // parent BOM and resolves spring-boot-starter-web → 3.2.0.
    expect(result.dependencies[0].declaredVersion).toBeUndefined();
  });

  it('preserves explicit declaredVersion (does NOT overwrite when already set)', async () => {
    cache.setMavenParentVersions('com.example', 'my-parent', '1.0.0', {
      'com.example:foo': '1.2.3',
    });
    const fetcher = vi.fn();
    const scan = baseScan({
      dependencies: [
        { name: 'com.example:foo', ecosystem: 'maven', declaredVersion: '9.9.9-OVERRIDE', kind: 'runtime' },
      ],
      parentCoords: { groupId: 'com.example', artifactId: 'my-parent', version: '1.0.0' },
    });
    const result = await enrichWithParentPom(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBe('9.9.9-OVERRIDE');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reads from cache on second call without invoking fetcher', async () => {
    cache.setMavenParentVersions('com.example', 'my-parent', '1.0.0', {
      'com.example:foo': '1.2.3',
    });
    const fetcher = vi.fn();
    const scan = baseScan({
      dependencies: [
        { name: 'com.example:foo', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      parentCoords: { groupId: 'com.example', artifactId: 'my-parent', version: '1.0.0' },
    });
    const result = await enrichWithParentPom(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBe('1.2.3');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails soft on network error — deps stay undefined, no throw', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const scan = baseScan({
      dependencies: [
        { name: 'com.example:foo', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      parentCoords: { groupId: 'com.example', artifactId: 'my-parent', version: '1.0.0' },
    });
    const result = await enrichWithParentPom(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fails soft on 404 — deps stay undefined, no throw', async () => {
    const fetcher = vi.fn(async () => notFoundResponse());
    const scan = baseScan({
      dependencies: [
        { name: 'com.example:foo', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      parentCoords: { groupId: 'com.example', artifactId: 'no-such-parent', version: '1.0.0' },
    });
    const result = await enrichWithParentPom(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBeUndefined();
  });

  it('fails soft on parse error — deps stay undefined, no throw', async () => {
    const fetcher = vi.fn(async () => okResponse('not-valid-xml-at-all'));
    const scan = baseScan({
      dependencies: [
        { name: 'com.example:foo', ecosystem: 'maven', declaredVersion: undefined, kind: 'runtime' },
      ],
      parentCoords: { groupId: 'com.example', artifactId: 'broken-parent', version: '1.0.0' },
    });
    const result = await enrichWithParentPom(scan, cache, fetcher);
    expect(result.dependencies[0].declaredVersion).toBeUndefined();
  });

  it('warm-cache regression: cached parent retains its nested BOM imports for the next call (Codex post-verify high fix)', async () => {
    // Cold + warm-cache pair: parent has only a <scope>import</scope> BOM (no
    // literal DM versions). Pre-fix, the SECOND call read the cached parent
    // row with `nestedBoms: []` → the BOM was no longer appended to
    // scan.bomImports → the spring-boot-dependencies path was lost.
    const fetcher = vi.fn(async (url: string) => {
      if (url === SPRING_BOOT_PARENT_URL) return okResponse(SPRING_BOOT_STARTER_PARENT_POM);
      return notFoundResponse();
    });
    const scan = baseScan({
      dependencies: [
        {
          name: 'org.springframework.boot:spring-boot-starter-web',
          ecosystem: 'maven',
          declaredVersion: undefined,
          kind: 'runtime',
        },
      ],
      parentCoords: {
        groupId: 'org.springframework.boot',
        artifactId: 'spring-boot-starter-parent',
        version: '3.2.0',
      },
    });

    // Cold call.
    const r1 = await enrichWithParentPom(scan, cache, fetcher);
    expect(r1.bomImports).toContainEqual({
      groupId: 'org.springframework.boot',
      artifactId: 'spring-boot-dependencies',
      version: '3.2.0',
    });

    // Warm call: cache hit MUST still surface nested BOMs.
    fetcher.mockClear();
    const r2 = await enrichWithParentPom(scan, cache, fetcher);
    expect(r2.bomImports).toContainEqual({
      groupId: 'org.springframework.boot',
      artifactId: 'spring-boot-dependencies',
      version: '3.2.0',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
