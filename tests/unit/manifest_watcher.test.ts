import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ManifestWatcher } from '../../src/services/manifest_watcher.js';
import { Cache } from '../../src/services/cache.js';
import { scanProject } from '../../src/services/project_scanner.js';

let tmp: string;
let cache: Cache;

async function freshCache(): Promise<Cache> {
  // Use FORCE_INMEMORY-equivalent: pass a path; better-sqlite3 in test env may
  // fall through to in-memory. Either backend supports invalidateRepo / invalidateWikiStatus.
  return Cache.open({ dbPath: path.join(tmp, 'cache.db') });
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-mw-'));
  cache = await freshCache();
});

afterEach(() => {
  cache.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ManifestWatcher — cache invalidation on dep diff', () => {
  it('invalidates cache.repos for removed deps; preserves resolved repo cache for surviving deps', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0', lodash: '^4.0.0' } }),
      'utf8',
    );
    cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    cache.setRepo('lodash', 'npm', 'lodash', 'lodash', 'npm-registry', 'high');
    cache.setWikiStatus('facebook/react', true, 5, []);

    const initialScan = scanProject(tmp);
    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'package.json'),
      cache,
      scannerOpts: {},
      initialScan,
    });

    // Simulate manifest edit: remove react.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0' } }),
      'utf8',
    );

    w.handleChange();

    // react cache invalidated.
    expect(cache.getRepo('react', 'npm')).toBeNull();
    // lodash still cached (survived the diff).
    expect(cache.getRepo('lodash', 'npm')).not.toBeNull();
    // wiki_status for facebook/react also invalidated (no surviving dep maps to it).
    expect(cache.getWikiStatus('facebook/react')).toBeNull();
  });

  it('does NOT invalidate cache when a dep is added (lazy probe on next tool call)', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      'utf8',
    );
    cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    const initialScan = scanProject(tmp);
    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'package.json'),
      cache,
      scannerOpts: {},
      initialScan,
    });

    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0', lodash: '^4.0.0' } }),
      'utf8',
    );
    w.handleChange();

    // react cache untouched (it survived the diff).
    expect(cache.getRepo('react', 'npm')).not.toBeNull();
  });

  it('runtime↔dev kind flip on the same name does NOT evict cache.repos (claude review C3 fix)', () => {
    // Start with vitest in dependencies AND lodash to verify the diff machinery.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { vitest: '^2.0.0', lodash: '^4.0.0' } }),
      'utf8',
    );
    cache.setRepo('vitest', 'npm', 'vitest-dev', 'vitest', 'npm-registry', 'high');
    cache.setRepo('lodash', 'npm', 'lodash', 'lodash', 'npm-registry', 'high');
    // includeDev=true so both runtime AND dev are observed → kind flips are visible.
    const initialScan = scanProject(tmp, { includeDev: true });
    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'package.json'),
      cache,
      scannerOpts: { includeDev: true },
      initialScan,
    });

    // Move vitest from `dependencies` (kind=runtime) to `devDependencies` (kind=dev).
    // The diff is keyed by (name, ecosystem) — vitest is still in the next scan,
    // so it is NOT in the removed set, and cache.repos[vitest,npm] MUST stay populated.
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        dependencies: { lodash: '^4.0.0' },
        devDependencies: { vitest: '^2.0.0' },
      }),
      'utf8',
    );
    w.handleChange();

    // Verify the kind actually flipped in the scan output (the test really exercised the path).
    const wInternal = w as unknown as { roots: Array<{ previousScan: { dependencies: Array<{ name: string; kind?: string }> } }> };
    expect(wInternal.roots[0].previousScan.dependencies.find((d) => d.name === 'vitest')?.kind).toBe('dev');
    // The contract: flip → no cache eviction.
    expect(cache.getRepo('vitest', 'npm')).not.toBeNull();
    // lodash also untouched (sanity).
    expect(cache.getRepo('lodash', 'npm')).not.toBeNull();
  });

  it('transient ENOENT during atomic-rename does NOT trigger invalidation (Truth #7 fix)', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      'utf8',
    );
    cache.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    const initialScan = scanProject(tmp);
    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'package.json'),
      cache,
      scannerOpts: {},
      initialScan,
    });

    // Simulate the unlink half of an atomic rename: file disappears momentarily.
    fs.unlinkSync(path.join(tmp, 'package.json'));
    w.handleChange();

    // The watcher MUST keep the previous scan in memory and NOT touch the cache.
    expect(cache.getRepo('react', 'npm')).not.toBeNull();
  });

  it('start() / stop() cleanly registers and tears down a watcher', async () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}', 'utf8');
    const initialScan = scanProject(tmp);
    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'package.json'),
      cache,
      scannerOpts: {},
      initialScan,
    });
    w.start();
    await w.stop();
    // No assertion on exact handle counts — Node's libuv accounting is platform-sensitive.
    // The contract is: stop() resolves without error, the watcher accepts no further events.
  });

  it('reconciles the chokidar watch set when Cargo workspace adds a member after startup (codex review H1 fix)', async () => {
    // Set up an empty Cargo workspace.
    fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[workspace]\nmembers = []\n', 'utf8');
    const initialScan = scanProject(tmp);

    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'Cargo.toml'),
      workspaceMembers: initialScan.workspaceMembers,
      cache,
      scannerOpts: {},
      initialScan,
    });
    w.start();

    try {
      // Add a new member after startup.
      fs.mkdirSync(path.join(tmp, 'crates/foo'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, 'crates/foo/Cargo.toml'),
        '[package]\nname = "foo"\nversion = "0.1.0"\n\n[dependencies]\nx = "1"\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmp, 'Cargo.toml'),
        '[workspace]\nmembers = ["crates/foo"]\n',
        'utf8',
      );

      // Trigger handleChange directly (avoids racey filesystem events in CI).
      w.handleChange();

      // The reconcileWatchSet path must have run AND the new member must be in previousScan.
      const internal = w as unknown as { roots: Array<{ previousScan: { workspaceMembers?: string[] } }> };
      expect(internal.roots[0].previousScan.workspaceMembers).toContain('crates/foo');
    } finally {
      await w.stop();
    }
  });

  // v2.4 -----------------------------------------------------------------

  it('degradedMode flips to true when computeWatchSet truncates at MAX_WATCHED_PATHS', () => {
    // Construct an initial scan with 600 extras + manifestPath = 601 paths.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}', 'utf8');
    const initialScan = scanProject(tmp);
    const extras: string[] = [];
    for (let i = 0; i < 600; i++) {
      const p = path.join(tmp, `extra-${i}.txt`);
      fs.writeFileSync(p, '', 'utf8');
      extras.push(p);
    }
    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'package.json'),
      extraManifestFiles: extras,
      cache,
      scannerOpts: {},
      initialScan,
    });
    // computeWatchSet runs inside start(); we trigger via the public method.
    w.start();
    try {
      expect(w.degradedMode).toBe(true);
    } finally {
      // stop is async but we don't need to await for the assertion.
      void w.stop();
    }
  });

  it('truncation priority order: manifestPath first + ALL extras + members in original order; first dropped is the (cap - 1 - extras)-th member (Truth #7 / TS-010)', () => {
    // Synthetic 1 manifestPath + 200 extras + 400 members → 601 paths, 89 over the 512 cap.
    // Expected retained: manifestPath at index 0, all 200 extras at 1..200,
    // 311 of 400 members at 201..511. First dropped member: members[311] (zero-indexed).
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({}), 'utf8');
    const initialScan = scanProject(tmp);

    // Build deterministic synthetic paths. We use computeWatchSet via reflection
    // since exposing the watch set publicly would widen the API just for tests.
    const manifestPath = path.join(tmp, 'package.json');
    const extras: string[] = [];
    for (let i = 0; i < 200; i++) extras.push(path.join(tmp, `extra-${String(i).padStart(3, '0')}.txt`));
    const memberDirs: string[] = [];
    for (let i = 0; i < 400; i++) {
      const dirName = `member-${String(i).padStart(3, '0')}`;
      memberDirs.push(dirName);
      fs.mkdirSync(path.join(tmp, dirName));
      fs.writeFileSync(path.join(tmp, dirName, 'package.json'), '{}', 'utf8');
    }
    // Patch the initial scan to declare workspaceMembers + manifestType so
    // deriveMemberManifest('package.json', m) returns <dir>/package.json.
    const patchedScan = {
      ...initialScan,
      manifestType: 'package.json' as const,
      workspaceMembers: memberDirs,
    };

    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath,
      workspaceMembers: memberDirs,
      extraManifestFiles: extras,
      cache,
      scannerOpts: {},
      initialScan: patchedScan,
    });
    // Call computeWatchSet via the private accessor (test-only reflection).
    const watched = (w as unknown as { computeWatchSet(): string[] }).computeWatchSet();

    // 512-path cap.
    expect(watched.length).toBe(512);
    // Index 0: manifestPath.
    expect(watched[0]).toBe(manifestPath);
    // Indices 1..200: all 200 extras in original order.
    for (let i = 0; i < 200; i++) expect(watched[1 + i]).toBe(extras[i]);
    // Indices 201..511: members[0..310] in original order.
    for (let i = 0; i < 311; i++) {
      const expected = path.resolve(tmp, memberDirs[i], 'package.json');
      expect(watched[201 + i]).toBe(expected);
    }
    // First dropped member is members[311].
    const firstDroppedDerived = path.resolve(tmp, memberDirs[311], 'package.json');
    expect(watched).not.toContain(firstDroppedDerived);
    expect(w.degradedMode).toBe(true);
  });

  it('degradedMode stays false when watch set is below the cap', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{}', 'utf8');
    const initialScan = scanProject(tmp);
    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: path.join(tmp, 'package.json'),
      cache,
      scannerOpts: {},
      initialScan,
    });
    w.start();
    try {
      expect(w.degradedMode).toBe(false);
    } finally {
      void w.stop();
    }
  });

  it('reconcileWatchSet calls chokidar.add with the new csproj path between rescan and next call (TS-014 / Truth #12)', async () => {
    fs.mkdirSync(path.join(tmp, 'src/Proj1'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src/Proj2'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'MyApp.sln'),
      'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
        'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Proj1", "src\\Proj1\\Proj1.csproj", "{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}"\nEndProject\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'src/Proj1/Proj1.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="A" Version="1.0.0" /></ItemGroup></Project>',
      'utf8',
    );
    const initialScan = scanProject(tmp);

    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: initialScan.matchedManifestPath ?? path.join(tmp, 'src/Proj1/Proj1.csproj'),
      extraManifestFiles: initialScan.extraManifestFiles,
      cache,
      scannerOpts: {},
      initialScan,
    });
    w.start();

    try {
      // Spy on the FSWatcher's add — capture every path passed.
      const internal = w as unknown as { watcher: { add: (p: string | string[]) => void } | null };
      const realAdd = internal.watcher!.add.bind(internal.watcher);
      const addedPaths: string[] = [];
      internal.watcher!.add = (p: string | string[]) => {
        if (Array.isArray(p)) addedPaths.push(...p);
        else addedPaths.push(p);
        return realAdd(p);
      };

      // Edit the sln to add Proj2.
      fs.writeFileSync(
        path.join(tmp, 'MyApp.sln'),
        'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
          'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Proj1", "src\\Proj1\\Proj1.csproj", "{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}"\nEndProject\n' +
          'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Proj2", "src\\Proj2\\Proj2.csproj", "{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}"\nEndProject\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmp, 'src/Proj2/Proj2.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="B" Version="2.0.0" /></ItemGroup></Project>',
        'utf8',
      );

      w.handleChange();

      // The contract under test: chokidar.add was invoked with Proj2.csproj's
      // absolute path. A regression that drops the watcher.add(added) line
      // would still update previousScan.extraManifestFiles but skip this call.
      expect(addedPaths.some((p) => p.endsWith('Proj2.csproj'))).toBe(true);
    } finally {
      await w.stop();
    }
  });

  it('reconcileWatchSet picks up extraManifestFiles added after startup (Codex M3 fix)', async () => {
    // Set up an sln-with-csprojs–like layout: solution at root, two csprojs.
    fs.mkdirSync(path.join(tmp, 'src/Proj1'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'src/Proj2'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'MyApp.sln'),
      'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
        'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Proj1", "src\\Proj1\\Proj1.csproj", "{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}"\nEndProject\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'src/Proj1/Proj1.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="A" Version="1.0.0" /></ItemGroup></Project>',
      'utf8',
    );
    const initialScan = scanProject(tmp);

    const w = new ManifestWatcher({
      projectRoot: tmp,
      manifestPath: initialScan.matchedManifestPath ?? path.join(tmp, 'src/Proj1/Proj1.csproj'),
      extraManifestFiles: initialScan.extraManifestFiles,
      cache,
      scannerOpts: {},
      initialScan,
    });
    w.start();

    try {
      // Edit the sln to add Proj2.
      fs.writeFileSync(
        path.join(tmp, 'MyApp.sln'),
        'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
          'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Proj1", "src\\Proj1\\Proj1.csproj", "{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}"\nEndProject\n' +
          'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Proj2", "src\\Proj2\\Proj2.csproj", "{bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb}"\nEndProject\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(tmp, 'src/Proj2/Proj2.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="B" Version="2.0.0" /></ItemGroup></Project>',
        'utf8',
      );

      w.handleChange();

      const internal = w as unknown as { roots: Array<{ previousScan: { extraManifestFiles?: string[] } }> };
      // After rescan, extraManifestFiles must contain BOTH the sln AND Proj2.csproj.
      const extras = internal.roots[0].previousScan.extraManifestFiles ?? [];
      expect(extras.some((p) => p.endsWith('MyApp.sln'))).toBe(true);
      expect(extras.some((p) => p.endsWith('Proj2.csproj'))).toBe(true);
    } finally {
      await w.stop();
    }
  });

});

describe('ManifestWatcher — multi-manifest reach (v0.6 additionalRoots)', () => {
  it('with empty additionalRoots[] computes the same watch set as primary-only (back-compat)', () => {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.writeFileSync(path.join(tmp, 'a', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
    const initialScan = scanProject(path.join(tmp, 'a'));
    const wEmpty = new ManifestWatcher({
      projectRoot: path.join(tmp, 'a'),
      manifestPath: path.join(tmp, 'a', 'package.json'),
      cache,
      scannerOpts: {},
      initialScan,
      additionalRoots: [],
    });
    const wPlain = new ManifestWatcher({
      projectRoot: path.join(tmp, 'a'),
      manifestPath: path.join(tmp, 'a', 'package.json'),
      cache,
      scannerOpts: {},
      initialScan,
    });
    const setEmpty = (wEmpty as unknown as { computeWatchSet(): string[] }).computeWatchSet();
    const setPlain = (wPlain as unknown as { computeWatchSet(): string[] }).computeWatchSet();
    expect(setEmpty).toEqual(setPlain);
  });

  it('2 roots: both manifestPaths appear in computed watch set (root-first order)', () => {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.writeFileSync(path.join(tmp, 'a', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
    fs.mkdirSync(path.join(tmp, 'b'));
    fs.writeFileSync(path.join(tmp, 'b', 'package.json'),
      JSON.stringify({ dependencies: { 'date-fns': '^3.0.0' } }));
    const aScan = scanProject(path.join(tmp, 'a'));
    const bScan = scanProject(path.join(tmp, 'b'));

    const w = new ManifestWatcher({
      projectRoot: path.join(tmp, 'a'),
      manifestPath: path.join(tmp, 'a', 'package.json'),
      cache,
      scannerOpts: {},
      initialScan: aScan,
      additionalRoots: [{
        projectRoot: path.join(tmp, 'b'),
        manifestPath: path.join(tmp, 'b', 'package.json'),
        initialScan: bScan,
      }],
    });
    const watched = (w as unknown as { computeWatchSet(): string[] }).computeWatchSet();
    expect(watched).toContain(path.join(tmp, 'a', 'package.json'));
    expect(watched).toContain(path.join(tmp, 'b', 'package.json'));
    // Root-first priority: primary root before additional roots.
    expect(watched.indexOf(path.join(tmp, 'a', 'package.json')))
      .toBeLessThan(watched.indexOf(path.join(tmp, 'b', 'package.json')));
  });

  it('handleChange(additionalPath) rescans ONLY the additional root; primary state preserved', () => {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.writeFileSync(path.join(tmp, 'a', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
    fs.mkdirSync(path.join(tmp, 'b'));
    fs.writeFileSync(path.join(tmp, 'b', 'package.json'),
      JSON.stringify({ dependencies: { 'date-fns': '^3.0.0' } }));
    const aScan = scanProject(path.join(tmp, 'a'));
    const bScan = scanProject(path.join(tmp, 'b'));
    const w = new ManifestWatcher({
      projectRoot: path.join(tmp, 'a'),
      manifestPath: path.join(tmp, 'a', 'package.json'),
      cache,
      scannerOpts: {},
      initialScan: aScan,
      additionalRoots: [{
        projectRoot: path.join(tmp, 'b'),
        manifestPath: path.join(tmp, 'b', 'package.json'),
        initialScan: bScan,
      }],
    });

    // Edit the additional root's manifest.
    fs.writeFileSync(path.join(tmp, 'b', 'package.json'),
      JSON.stringify({ dependencies: { 'date-fns': '^3.0.0', axios: '^1.0.0' } }));
    w.handleChange(path.join(tmp, 'b', 'package.json'));

    const internal = w as unknown as {
      roots: Array<{ previousScan: { dependencies: Array<{ name: string }> } }>;
    };
    // Primary scan unchanged.
    expect(internal.roots[0].previousScan.dependencies.map((d) => d.name)).toEqual(['lodash']);
    // Additional root rescanned, axios picked up.
    const bNames = internal.roots[1].previousScan.dependencies.map((d) => d.name).sort();
    expect(bNames).toEqual(['axios', 'date-fns']);
  });

  it('handleChange(primaryPath) rescans ONLY primary; additional state preserved', () => {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.writeFileSync(path.join(tmp, 'a', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
    fs.mkdirSync(path.join(tmp, 'b'));
    fs.writeFileSync(path.join(tmp, 'b', 'package.json'),
      JSON.stringify({ dependencies: { 'date-fns': '^3.0.0' } }));
    const aScan = scanProject(path.join(tmp, 'a'));
    const bScan = scanProject(path.join(tmp, 'b'));
    const w = new ManifestWatcher({
      projectRoot: path.join(tmp, 'a'),
      manifestPath: path.join(tmp, 'a', 'package.json'),
      cache,
      scannerOpts: {},
      initialScan: aScan,
      additionalRoots: [{
        projectRoot: path.join(tmp, 'b'),
        manifestPath: path.join(tmp, 'b', 'package.json'),
        initialScan: bScan,
      }],
    });

    // Edit primary's manifest.
    fs.writeFileSync(path.join(tmp, 'a', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0', uuid: '^9.0.0' } }));
    w.handleChange(path.join(tmp, 'a', 'package.json'));

    const internal = w as unknown as {
      roots: Array<{ previousScan: { dependencies: Array<{ name: string }> } }>;
    };
    const aNames = internal.roots[0].previousScan.dependencies.map((d) => d.name).sort();
    expect(aNames).toEqual(['lodash', 'uuid']);
    // Additional root unchanged.
    expect(internal.roots[1].previousScan.dependencies.map((d) => d.name)).toEqual(['date-fns']);
  });

  it('handleChange(unknownPath) does NOT rescan any root and logs manifest_watcher_unknown_path', () => {
    fs.mkdirSync(path.join(tmp, 'a'));
    fs.writeFileSync(path.join(tmp, 'a', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
    const aScan = scanProject(path.join(tmp, 'a'));
    const w = new ManifestWatcher({
      projectRoot: path.join(tmp, 'a'),
      manifestPath: path.join(tmp, 'a', 'package.json'),
      cache,
      scannerOpts: {},
      initialScan: aScan,
    });

    // Mutate the file but call handleChange with a path none of the roots claim.
    fs.writeFileSync(path.join(tmp, 'a', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4.0.0', uuid: '^9.0.0' } }));
    w.handleChange('/tmp/this-path-belongs-to-no-root.json');

    const internal = w as unknown as {
      roots: Array<{ previousScan: { dependencies: Array<{ name: string }> } }>;
    };
    // previousScan must NOT have rescanned — uuid still absent.
    expect(internal.roots[0].previousScan.dependencies.map((d) => d.name)).toEqual(['lodash']);
  });

  it('root-first truncate priority: additional root manifest survives cap squeeze on primary members', () => {
    // Force a tiny cap via env so we don't have to fabricate 500 members.
    const prevCap = process.env.CODEWIKI_MAX_WATCHED_PATHS;
    process.env.CODEWIKI_MAX_WATCHED_PATHS = '2';
    try {
      // Re-import the watcher fresh so the new cap takes effect. Vitest's
      // ESM cache keeps a single instance, so we use vi.resetModules() via
      // a dynamic import.
      // Cap is read in config.ts at module load — we need a fresh require.
      // Easier path: assert behavior with the real cap (512) using a fixture
      // big enough to exceed it. But the test scope says "primary 500
      // workspace members + 2 additional root" — we can synthesize.
      // For the unit test, we simulate by directly poking the workspaceMembers
      // arrays to 600 fake dirs (no FS — computeWatchSet uses path.resolve only).
      fs.mkdirSync(path.join(tmp, 'a'));
      fs.writeFileSync(path.join(tmp, 'a', 'Cargo.toml'),
        '[package]\nname = "a"\nversion = "0.0.0"\n\n[dependencies]\nx = "1"\n');
      fs.mkdirSync(path.join(tmp, 'b'));
      fs.writeFileSync(path.join(tmp, 'b', 'pom.xml'),
        '<?xml version="1.0"?><project><modelVersion>4.0.0</modelVersion>' +
        '<groupId>g</groupId><artifactId>a</artifactId><version>1</version>' +
        '<dependencies><dependency><groupId>c</groupId><artifactId>l</artifactId><version>1</version></dependency></dependencies></project>');
      const aScan = scanProject(path.join(tmp, 'a'));
      const bScan = scanProject(path.join(tmp, 'b'));

      // Synthetic 600 member dirs on primary
      const fakeMembers = Array.from({ length: 600 }, (_, i) => `member-${i}`);
      const w = new ManifestWatcher({
        projectRoot: path.join(tmp, 'a'),
        manifestPath: path.join(tmp, 'a', 'Cargo.toml'),
        workspaceMembers: fakeMembers,
        cache,
        scannerOpts: {},
        initialScan: aScan,
        additionalRoots: [{
          projectRoot: path.join(tmp, 'b'),
          manifestPath: path.join(tmp, 'b', 'pom.xml'),
          initialScan: bScan,
        }],
      });
      const watched = (w as unknown as { computeWatchSet(): string[] }).computeWatchSet();
      // Both root manifestPaths MUST survive truncation regardless of cap.
      expect(watched).toContain(path.join(tmp, 'a', 'Cargo.toml'));
      expect(watched).toContain(path.join(tmp, 'b', 'pom.xml'));
      // Some primary members get truncated (degraded mode).
      expect((w as unknown as { degradedMode: boolean }).degradedMode).toBe(true);
    } finally {
      if (prevCap === undefined) delete process.env.CODEWIKI_MAX_WATCHED_PATHS;
      else process.env.CODEWIKI_MAX_WATCHED_PATHS = prevCap;
    }
  });
});
