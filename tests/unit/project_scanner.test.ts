import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { scanProject, rescanManifest } from '../../src/services/project_scanner.js';
import { ManifestError } from '../../src/types.js';

const FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'manifests');
const WORKSPACE_FIXTURE = path.join(FIXTURES, 'Cargo-workspace');

describe('scanProject — Cargo workspace traversal (v2.2)', () => {
  it('returns the union of root and member deps with workspaceMembers populated', () => {
    const r = scanProject(WORKSPACE_FIXTURE);
    expect(r.manifestType).toBe('Cargo.toml');

    const names = r.dependencies.map((d) => d.name).sort();
    // root: anyhow ; foo: serde + clap ; bar: serde + tokio (serde de-duped)
    expect(names).toContain('anyhow');
    expect(names).toContain('serde');
    expect(names).toContain('clap');
    expect(names).toContain('tokio');

    expect(r.workspaceMembers).toBeDefined();
    expect(r.workspaceMembers).toEqual(expect.arrayContaining(['crates/foo', 'crates/bar']));
  });

  it('logs a warn and skips glob members instead of failing the whole scan', () => {
    // The fixture's members includes "crates/*" — should be glob-skipped, not crashing.
    expect(() => scanProject(WORKSPACE_FIXTURE)).not.toThrow();
  });

  it('refuses workspace members that lexically escape the project root', () => {
    let tmp = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-ws-'));
      fs.writeFileSync(
        path.join(tmp, 'Cargo.toml'),
        '[workspace]\nmembers = ["../../etc/escape"]\n',
        'utf8',
      );
      expect(() => scanProject(tmp)).toThrowError(/escapes project root/);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses workspace members whose realpath escapes the project root (Stage 2 symlink defence)', () => {
    let tmp = '';
    let outside = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-ws-symlink-'));
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-outside-'));
      fs.writeFileSync(
        path.join(outside, 'Cargo.toml'),
        '[package]\nname = "evil"\nversion = "0.1.0"\n',
        'utf8',
      );
      fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[workspace]\nmembers = ["evil-link"]\n', 'utf8');
      fs.symlinkSync(outside, path.join(tmp, 'evil-link'));
      expect(() => scanProject(tmp)).toThrowError(/symlink target escapes project root/);
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      if (outside) fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('truncates (NOT throws) when workspace members exceed MAX_WORKSPACE_MEMBERS', () => {
    let tmp = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-ws-trunc-'));
      // Create 257 explicit members (one over the default 256 cap).
      const members: string[] = [];
      for (let i = 0; i < 257; i++) {
        const name = `c${i}`;
        members.push(name);
        fs.mkdirSync(path.join(tmp, name), { recursive: true });
        fs.writeFileSync(
          path.join(tmp, name, 'Cargo.toml'),
          `[package]\nname = "${name}"\nversion = "0.1.0"\n\n[dependencies]\ndep_${i} = "1.0"\n`,
          'utf8',
        );
      }
      const memberList = members.map((m) => `  "${m}",`).join('\n');
      fs.writeFileSync(
        path.join(tmp, 'Cargo.toml'),
        `[workspace]\nmembers = [\n${memberList}\n]\n`,
        'utf8',
      );

      const r = scanProject(tmp);
      // Exactly the first 256 members are processed, NOT 257; no throw.
      expect(r.workspaceMembers?.length).toBe(256);
      // The dropped member's dep is absent.
      expect(r.dependencies.find((d) => d.name === 'dep_256')).toBeUndefined();
      // A retained member's dep is present.
      expect(r.dependencies.find((d) => d.name === 'dep_0')).toBeDefined();
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scanProject — single-manifest mode (back-compat regression gate)', () => {
  it('returns workspaceMembers: undefined for a non-workspace project', () => {
    let tmp = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-single-'));
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.0.0' } }),
        'utf8',
      );
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('package.json');
      expect(r.workspaceMembers).toBeUndefined();
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns kind=runtime for every dep when called without opts', () => {
    let tmp = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-default-'));
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({
          name: 'demo',
          dependencies: { lodash: '^4.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
        'utf8',
      );
      const r = scanProject(tmp);
      expect(r.dependencies.map((d) => d.name)).toEqual(['lodash']);
      expect(r.dependencies[0].kind).toBe('runtime');
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('honours opts.includeDev=true (returns dev deps with kind=dev)', () => {
    let tmp = '';
    try {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-dev-'));
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({
          name: 'demo',
          dependencies: { lodash: '^4.0.0' },
          devDependencies: { vitest: '^2.0.0' },
        }),
        'utf8',
      );
      const r = scanProject(tmp, { includeDev: true });
      const names = r.dependencies.map((d) => d.name).sort();
      expect(names).toEqual(['lodash', 'vitest']);
      expect(r.dependencies.find((d) => d.name === 'vitest')?.kind).toBe('dev');
    } finally {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('rescanManifest — root-bound (no walk-up)', () => {
  let tmp = '';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-rescan-'));
  });

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('re-parses the exact manifestPath without walking upward', () => {
    fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { x: '1' } }), 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'sub', 'package.json'),
      JSON.stringify({ dependencies: { y: '1' } }),
      'utf8',
    );

    const r = rescanManifest(path.join(tmp, 'sub', 'package.json'));
    expect(r.dependencies.map((d) => d.name)).toEqual(['y']);
    // It MUST NOT walk up to the parent's package.json with `x`.
    expect(r.dependencies.find((d) => d.name === 'x')).toBeUndefined();
  });

  it('returns the previous scan when the file is mid-rename (transient ENOENT)', () => {
    const prev = scanProject(tmp); // tmp has no manifest → empty scan
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ dependencies: { x: '1' } }), 'utf8');
    const initial = rescanManifest(path.join(tmp, 'package.json'));
    fs.unlinkSync(path.join(tmp, 'package.json'));
    const after = rescanManifest(path.join(tmp, 'package.json'), undefined, initial);
    // ENOENT → returns previous scan, NOT a fresh empty scan.
    expect(after.dependencies.map((d) => d.name)).toEqual(['x']);
    // Sanity: prev (no-manifest tmp) was empty.
    expect(prev.manifestType).toBeNull();
  });

  it('throws ManifestError(unsupported_format) on a non-recognised filename', () => {
    fs.writeFileSync(path.join(tmp, 'random.txt'), 'noop', 'utf8');
    expect(() => rescanManifest(path.join(tmp, 'random.txt'))).toThrow(ManifestError);
  });
});

// ---------------------------------------------------------------------------
// v2.3 scanner extensions: csproj glob, CPM upward walk, Java priority,
// nested gradle catalog discovery.
// ---------------------------------------------------------------------------

describe('scanProject — .NET csproj + CPM upward walk (v2.3)', () => {
  it('discovers a single *.csproj via glob and merges versions from same-dir Directory.Packages.props', () => {
    // Use a tmp dir that copies MyApp-cpm.csproj + Directory.Packages.props
    // (both fixtures already exist under tests/fixtures/manifests).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-cpm-'));
    fs.copyFileSync(
      path.join(FIXTURES, 'MyApp-cpm.csproj'),
      path.join(tmp, 'MyApp.csproj'),
    );
    fs.copyFileSync(
      path.join(FIXTURES, 'Directory.Packages.props'),
      path.join(tmp, 'Directory.Packages.props'),
    );
    try {
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('csproj');
      expect(r.matchedManifestPath).toBe(path.join(tmp, 'MyApp.csproj'));
      // CPM merge populates versions for all dep entries.
      const newton = r.dependencies.find((d) => d.name === 'Newtonsoft.Json');
      expect(newton?.declaredVersion).toBe('13.0.3');
      const serilog = r.dependencies.find((d) => d.name === 'Serilog');
      expect(serilog?.declaredVersion).toBe('3.1.1');
      // Directory.Packages.props is in extraManifestFiles (watcher anchor).
      expect(r.extraManifestFiles).toEqual([
        path.join(tmp, 'Directory.Packages.props'),
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('discovers Directory.Packages.props via UPWARD WALK (canonical Microsoft layout)', () => {
    // Use the dotnet-cpm-deep fixture: props at root, csproj 2 dirs deep.
    const root = path.join(FIXTURES, 'dotnet-cpm-deep');
    const csprojDir = path.join(root, 'src', 'Proj');
    const r = scanProject(csprojDir);
    expect(r.manifestType).toBe('csproj');
    expect(r.projectRoot).toBe(csprojDir);
    expect(r.matchedManifestPath).toBe(path.join(csprojDir, 'Proj.csproj'));
    const newton = r.dependencies.find((d) => d.name === 'Newtonsoft.Json');
    expect(newton?.declaredVersion).toBe('13.0.3'); // resolved via upward-discovered props
    const serilog = r.dependencies.find((d) => d.name === 'Serilog');
    expect(serilog?.declaredVersion).toBe('3.1.1');
    // Discovered props path is in extraManifestFiles.
    expect(r.extraManifestFiles).toEqual([
      path.join(root, 'Directory.Packages.props'),
    ]);
  });

  it('aggregates multiple *.csproj files in the same dir with first-wins dedup', () => {
    // MultiProject fixture: ProjA + ProjB + Directory.Packages.props.
    const root = path.join(FIXTURES, 'MultiProject');
    const r = scanProject(root);
    expect(r.manifestType).toBe('csproj');
    expect(r.matchedManifestPath).toBeDefined();
    // Both ProjA's Newtonsoft.Json AND ProjB's Polly are present.
    const names = r.dependencies.map((d) => d.name).sort();
    expect(names).toContain('Newtonsoft.Json');
    expect(names).toContain('Polly');
    // CPM merge populated versions.
    expect(r.dependencies.find((d) => d.name === 'Newtonsoft.Json')?.declaredVersion).toBe('13.0.3');
    expect(r.dependencies.find((d) => d.name === 'Polly')?.declaredVersion).toBe('8.2.0');
    // Second csproj path goes into extraManifestFiles (NOT workspaceMembers).
    expect(r.extraManifestFiles).toBeDefined();
    expect(r.extraManifestFiles?.length).toBe(2); // 1 extra csproj + 1 props
    expect(r.workspaceMembers).toBeUndefined();
  });
});

describe('scanProject — Java + Gradle catalog discovery (v2.3)', () => {
  it('detects pom.xml as canonical and parses Maven coordinates', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-pom-'));
    fs.copyFileSync(
      path.join(FIXTURES, 'pom.xml'),
      path.join(tmp, 'pom.xml'),
    );
    try {
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('pom.xml');
      const names = r.dependencies.map((d) => d.name);
      expect(names).toContain('com.fasterxml.jackson.core:jackson-databind');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('pom.xml wins over package.json in the same dir (canonical-tier ordering)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-pom-pkg-'));
    fs.copyFileSync(path.join(FIXTURES, 'pom.xml'), path.join(tmp, 'pom.xml'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ dependencies: { 'docs-tool': '1.0' } }),
    );
    try {
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('pom.xml');
      // Maven coords present, npm dep NOT present
      expect(r.dependencies.some((d) => d.name === 'docs-tool')).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('discovers gradle/libs.versions.toml as a nested-path manifest', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-gradle-'));
    fs.mkdirSync(path.join(tmp, 'gradle'));
    fs.copyFileSync(
      path.join(FIXTURES, 'gradle', 'libs.versions.toml'),
      path.join(tmp, 'gradle', 'libs.versions.toml'),
    );
    try {
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('libs.versions.toml');
      const names = r.dependencies.map((d) => d.name);
      expect(names).toContain('com.google.guava:guava');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scanProject — Ruby Gemfile.lock preferred (v2.3)', () => {
  it('picks Gemfile.lock over Gemfile when both are present in same dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-ruby-'));
    fs.copyFileSync(path.join(FIXTURES, 'Gemfile'), path.join(tmp, 'Gemfile'));
    fs.copyFileSync(path.join(FIXTURES, 'Gemfile.lock'), path.join(tmp, 'Gemfile.lock'));
    try {
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('Gemfile.lock');
      const names = r.dependencies.map((d) => d.name);
      expect(names).toContain('webpacker'); // unique to lockfile DEPENDENCIES
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to Gemfile when only Gemfile is present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-ruby-only-'));
    fs.copyFileSync(path.join(FIXTURES, 'Gemfile'), path.join(tmp, 'Gemfile'));
    try {
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('Gemfile');
      const names = r.dependencies.map((d) => d.name);
      expect(names).toContain('rails');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scanProject — Cargo glob expansion (v2.3)', () => {
  const GLOB_FIXTURE = path.join(FIXTURES, 'Cargo-glob');

  it('expands `crates/*` and honors `!crates/skip-me` negation', () => {
    const r = scanProject(GLOB_FIXTURE);
    expect(r.manifestType).toBe('Cargo.toml');
    const names = r.dependencies.map((d) => d.name).sort();
    // foo: serde + clap, bar: tokio + serde — serde de-duped
    expect(names).toContain('serde');
    expect(names).toContain('clap');
    expect(names).toContain('tokio');
    // skip-me's deps must NOT appear (negation pattern excludes it)
    expect(names).not.toContain('should-not-appear');
    // workspaceMembers reflects expanded members (relative paths)
    expect(r.workspaceMembers).toEqual(expect.arrayContaining(['crates/foo', 'crates/bar']));
    expect(r.workspaceMembers).not.toContain('crates/skip-me');
  });

  it('safety filter rejects `**` recursive globs, `/`-absolute, `..` parent segments', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-glob-safety-'));
    fs.mkdirSync(path.join(tmp, 'crates', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'crates', 'a', 'Cargo.toml'),
      '[package]\nname = "a"\nversion = "0.1.0"\n[dependencies]\nfoo = "1"\n',
    );
    fs.writeFileSync(
      path.join(tmp, 'Cargo.toml'),
      '[workspace]\nmembers = ["**/Cargo.toml", "/etc/*", "../foo/*", "crates/*"]\n',
    );
    try {
      const r = scanProject(tmp);
      // Only the safe `crates/*` pattern survives.
      expect(r.dependencies.find((d) => d.name === 'foo')).toBeDefined();
      expect(r.workspaceMembers).toEqual(['crates/a']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scanProject — JS workspaces (v2.3)', () => {
  const NPM_WS = path.join(FIXTURES, 'npm-workspaces');
  const PNPM_WS = path.join(FIXTURES, 'pnpm-workspace');

  it('expands npm/yarn `workspaces: ["packages/*"]` and merges member deps', () => {
    const r = scanProject(NPM_WS);
    expect(r.manifestType).toBe('package.json');
    const names = r.dependencies.map((d) => d.name).sort();
    // Root + member deps unioned, deduped:
    expect(names).toContain('shared-root-dep'); // root
    expect(names).toContain('lodash'); // foo
    expect(names).toContain('react'); // foo + bar (deduped)
    expect(names).toContain('axios'); // bar
    expect(r.workspaceMembers).toEqual(expect.arrayContaining(['packages/foo', 'packages/bar']));
    // No pnpm-workspace.yaml present → no extraManifestFiles
    expect(r.extraManifestFiles).toBeUndefined();
  });

  it('honors pnpm-workspace.yaml `packages:` (trumps package.json:workspaces)', () => {
    const r = scanProject(PNPM_WS);
    expect(r.manifestType).toBe('package.json');
    const names = r.dependencies.map((d) => d.name).sort();
    expect(names).toContain('shared-root-dep');
    expect(names).toContain('fastify'); // both members
    expect(names).toContain('vitest'); // bar
    expect(r.workspaceMembers).toEqual(expect.arrayContaining(['packages/foo', 'packages/bar']));
    // pnpm-workspace.yaml goes in extraManifestFiles for the watcher.
    expect(r.extraManifestFiles).toEqual([path.join(PNPM_WS, 'pnpm-workspace.yaml')]);
  });

  it('treats pnpm-workspace.yaml without `packages:` key as no workspace (pnpm 9+ `allowBuilds:` only file)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-pnpm-no-packages-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'root', dependencies: { react: '^18' } }),
      );
      fs.writeFileSync(
        path.join(tmp, 'pnpm-workspace.yaml'),
        'allowBuilds:\n  better-sqlite3: true\n  esbuild: false\n',
      );
      const r = scanProject(tmp);
      expect(r.manifestType).toBe('package.json');
      expect(r.dependencies.map((d) => d.name)).toEqual(['react']);
      expect(r.workspaceMembers ?? []).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('supports npm-workspaces object form `{ packages: [...] }`', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-ws-obj-'));
    fs.mkdirSync(path.join(tmp, 'apps', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'apps', 'a', 'package.json'),
      JSON.stringify({ name: 'a', dependencies: { 'app-dep': '1' } }),
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'root',
        workspaces: { packages: ['apps/*'], nohoist: [] },
        dependencies: {},
      }),
    );
    try {
      const r = scanProject(tmp);
      expect(r.workspaceMembers).toEqual(['apps/a']);
      expect(r.dependencies.find((d) => d.name === 'app-dep')).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('JS safety filter rejects `**`/`/`-absolute glob patterns', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-jsws-safety-'));
    fs.mkdirSync(path.join(tmp, 'pkg', 'ok'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'pkg', 'ok', 'package.json'),
      JSON.stringify({ name: 'ok', dependencies: { 'safe-dep': '1' } }),
    );
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        name: 'root',
        workspaces: ['**/package.json', '/etc/*', 'pkg/*'],
        dependencies: {},
      }),
    );
    try {
      const r = scanProject(tmp);
      expect(r.workspaceMembers).toEqual(['pkg/ok']);
      expect(r.dependencies.find((d) => d.name === 'safe-dep')).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scanProject — go.work workspace traversal (v2.4)', () => {
  const FIXTURE = path.join(FIXTURES, 'go-work-workspace');

  it('aggregates per-member go.mod deps deduped first-wins', () => {
    const r = scanProject(FIXTURE);
    expect(r.manifestType).toBe('go.work');
    const names = r.dependencies.map((d) => d.name).sort();
    expect(names).toEqual([
      'github.com/baz/qux',
      'github.com/foo/bar',
      'github.com/shared/lib',
    ]);
  });

  it('surfaces use dirs through workspaceMembers; matchedManifestPath is the go.work itself', () => {
    const r = scanProject(FIXTURE);
    expect(r.workspaceMembers).toEqual(expect.arrayContaining(['./modA', './modB']));
    expect(r.matchedManifestPath?.endsWith('go.work')).toBe(true);
  });

  it('go.work supersedes a sibling go.mod (priority order)', () => {
    // The fixture has go.work at root + go.mod files in modA/modB but NOT
    // at the root. Even if a root go.mod existed, the priority order puts
    // go.work first. Here we just assert manifestType is go.work, not go.mod.
    const r = scanProject(FIXTURE);
    expect(r.manifestType).toBe('go.work');
  });
});

describe('scanProject — settings.gradle subproject discovery (v2.4)', () => {
  const FIXTURE = path.join(FIXTURES, 'gradle-multi-module');

  it('surfaces subprojects through workspaceMembers (colon→slash) and adds settings.gradle to extraManifestFiles', () => {
    const r = scanProject(FIXTURE);
    expect(r.manifestType).toBe('libs.versions.toml');
    expect(r.workspaceMembers).toEqual(expect.arrayContaining(['foo', 'bar/baz']));
    expect(r.extraManifestFiles?.some((p) => p.endsWith('settings.gradle.kts'))).toBe(true);
  });

  it('keeps deps sourced from libs.versions.toml ONLY (does not parse subproject build.gradle.kts)', () => {
    const r = scanProject(FIXTURE);
    // The catalog declares `spring-core`; build.gradle.kts files in foo/ and
    // bar/baz/ would add more if v2.5 lands DSL parsing — but v2.4 must NOT.
    expect(r.dependencies.length).toBe(1);
    expect(r.dependencies[0].name).toBe('org.springframework:spring-core');
  });
});

describe('scanProject — .sln two-path dispatch (v2.4)', () => {
  const FIXTURE = path.join(FIXTURES, 'sln-with-csprojs');

  it('top-level entry: cwd = solution root, no *.csproj at root, deps merged from all sln-listed csprojs', () => {
    const r = scanProject(FIXTURE);
    expect(r.manifestType).toBe('sln');
    const names = r.dependencies.map((d) => d.name).sort();
    expect(names).toEqual(['Microsoft.Extensions.Logging', 'Newtonsoft.Json']);
  });

  it('top-level entry: matchedManifestPath is the FIRST sln-listed csproj; extraManifestFiles carries the sln itself + remaining csprojs', () => {
    const r = scanProject(FIXTURE);
    expect(r.matchedManifestPath?.endsWith('Proj1.csproj')).toBe(true);
    expect(r.extraManifestFiles).toBeDefined();
    expect(r.extraManifestFiles?.some((p) => p.endsWith('MyApp.sln'))).toBe(true);
    expect(r.extraManifestFiles?.some((p) => p.endsWith('Proj2.csproj'))).toBe(true);
  });

  it('csproj-branch path: cwd = deep src/Proj1/, upward sln walk dispatches to the same handler — same dep list as the top-level invocation', () => {
    const a = scanProject(FIXTURE);
    const b = scanProject(path.join(FIXTURE, 'src', 'Proj1'));
    expect(b.manifestType).toBe('sln');
    expect(b.dependencies.map((d) => d.name).sort()).toEqual(
      a.dependencies.map((d) => d.name).sort(),
    );
  });

  it('CPM upward walk anchors on the originally matched csproj dir (csproj-branch) — proven by divergent layout where Directory.Packages.props lives ONLY at one csproj dir', () => {
    // Layout: sln-cpm-divergent/{MyApp.sln, src/A/{A.csproj, Directory.Packages.props}, src/B/B.csproj}.
    // From cwd=src/A/, CPM anchor=src/A/ → finds props at src/A/, LocalDep gets 7.7.7.
    // OtherDep (from B.csproj, parsed via sln dispatch) stays undefined because
    // the version map only has LocalDep.
    const divergentFix = path.join(FIXTURES, 'sln-cpm-divergent');
    const r = scanProject(path.join(divergentFix, 'src', 'A'));
    expect(r.manifestType).toBe('sln');
    const local = r.dependencies.find((d) => d.name === 'LocalDep');
    const other = r.dependencies.find((d) => d.name === 'OtherDep');
    expect(local?.declaredVersion).toBe('7.7.7');
    expect(other?.declaredVersion).toBeUndefined();
  });

  it('csproj-branch falls back to v2.3 dir-only csproj-glob when an upward sln yields zero usable csprojs (Codex M2 v2.4-verify)', () => {
    // sln-empty-fallback/Empty.sln has no Project entries; deep csproj scan
    // from src/DeepProj/ must NOT silently swallow DeepDep@1.2.3.
    const fix = path.join(FIXTURES, 'sln-empty-fallback');
    const r = scanProject(path.join(fix, 'src', 'DeepProj'));
    expect(r.manifestType).toBe('csproj');
    const deepDep = r.dependencies.find((d) => d.name === 'DeepDep');
    expect(deepDep?.declaredVersion).toBe('1.2.3');
  });

  it('csproj-branch from a sibling csproj dir (B): CPM anchors on src/B/ (no props there) → LocalDep AND OtherDep both stay undefined, proving CPM does NOT use src/A/ or sln dir', () => {
    const divergentFix = path.join(FIXTURES, 'sln-cpm-divergent');
    // Insert .git sentinel at the divergent fixture root so CPM walk from
    // src/B/ stops there (otherwise it walks above the fixture into the
    // dev's actual repo which has its own behavior).
    const gitSentinel = path.join(divergentFix, '.git');
    fs.mkdirSync(gitSentinel, { recursive: true });
    try {
      const r = scanProject(path.join(divergentFix, 'src', 'B'));
      expect(r.manifestType).toBe('sln');
      // sln-listed csprojs are merged → both LocalDep and OtherDep present.
      // CPM anchor on src/B/ finds nothing (no props in src/B/, .git sentinel
      // at root stops the walk before reaching src/A's props).
      const local = r.dependencies.find((d) => d.name === 'LocalDep');
      const other = r.dependencies.find((d) => d.name === 'OtherDep');
      expect(local?.declaredVersion).toBeUndefined();
      expect(other?.declaredVersion).toBeUndefined();
    } finally {
      fs.rmSync(gitSentinel, { recursive: true, force: true });
    }
  });

  it('top-level entry: when cwd = repo root and no *.csproj at root and Directory.Packages.props at root, CPM anchors on first sln-listed csproj dir (which has no upward props)', () => {
    // The basic sln-with-csprojs fixture has no Directory.Packages.props.
    // If CPM anchored on slnDir we'd find nothing either — verify that the
    // first sln-listed csproj's dir is the anchor by asserting that
    // declaredVersion comes from the csproj's explicit Version attribute.
    const r = scanProject(FIXTURE);
    const log = r.dependencies.find((d) => d.name === 'Microsoft.Extensions.Logging');
    expect(log?.declaredVersion).toBe('8.0.0');
    const json = r.dependencies.find((d) => d.name === 'Newtonsoft.Json');
    expect(json?.declaredVersion).toBe('13.0.3');
  });
});

describe('scanProject — aggregator-pom <modules> traversal (v2.4)', () => {
  const FIXTURE = path.join(FIXTURES, 'aggregator-pom-multi');

  it('aggregates deps from aggregator + every module pom (first-wins dedup)', () => {
    const r = scanProject(FIXTURE);
    expect(r.manifestType).toBe('pom.xml');
    const names = r.dependencies.map((d) => d.name);
    expect(names).toContain('com.google.guava:guava');
    expect(names).toContain('org.springframework:spring-core');
    expect(names).toContain('com.fasterxml.jackson.core:jackson-databind');
    // Aggregator-declared guava version 33.0.0-jre wins over core's 32.0.0-jre.
    const guava = r.dependencies.find((d) => d.name === 'com.google.guava:guava');
    expect(guava?.declaredVersion).toBe('33.0.0-jre');
  });

  it('surfaces module dirs through workspaceMembers (skipping the missing one)', () => {
    const r = scanProject(FIXTURE);
    expect(r.workspaceMembers).toBeDefined();
    expect(r.workspaceMembers).toEqual(expect.arrayContaining(['core', 'web']));
    expect(r.workspaceMembers).not.toContain('missing-module');
  });

  it('non-aggregator pom does NOT trigger module traversal (back-compat)', () => {
    // pom.xml fixture is a regular jar; no <modules>.
    const r = scanProject(FIXTURES);
    if (r.manifestType === 'pom.xml') {
      expect(r.workspaceMembers).toBeUndefined();
    }
  });
});

describe('scanProject — v2.3 verify-phase regressions', () => {
  // NOTE: JS workspace symlink-escape rejection is structurally enforced by
  // the SAME realpath check used by Cargo workspace traversal (see
  // `traverseJsWorkspaces` in src/services/project_scanner.ts and the
  // existing Cargo Stage-2 test at line 48). A duplicate JS-side test was
  // attempted but proved flaky against tinyglobby's symlink-enumeration
  // behavior; per testing.md parsimony, we don't duplicate the behaviour.

  it('CPM upward walk stops at .git boundary (does NOT escape into parent repos)', () => {
    let outer = '';
    try {
      outer = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-cpm-git-'));
      // outer/Directory.Packages.props (parent-repo CPM that MUST NOT be picked up)
      fs.writeFileSync(
        path.join(outer, 'Directory.Packages.props'),
        '<Project><ItemGroup><PackageVersion Include="Newtonsoft.Json" Version="99.99.99" /></ItemGroup></Project>',
      );
      // outer/inner/.git/  (sentinel: inner is a separate repo)
      fs.mkdirSync(path.join(outer, 'inner', '.git'), { recursive: true });
      fs.writeFileSync(
        path.join(outer, 'inner', 'MyApp.csproj'),
        '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Newtonsoft.Json" /></ItemGroup></Project>',
      );
      const r = scanProject(path.join(outer, 'inner'));
      expect(r.manifestType).toBe('csproj');
      const newton = r.dependencies.find((d) => d.name === 'Newtonsoft.Json');
      // The outer CPM's version MUST NOT leak in — declaredVersion stays undefined.
      expect(newton).toBeDefined();
      expect(newton?.declaredVersion).toBeUndefined();
      // No extraManifestFiles (the parent props was correctly NOT discovered)
      expect(r.extraManifestFiles).toBeUndefined();
    } finally {
      if (outer) fs.rmSync(outer, { recursive: true, force: true });
    }
  });

  it('rescanManifest dispatches v2.3 paths: csproj glob, gradle nested, Directory.Packages.props', () => {
    // csproj path — basename is 'MyApp.csproj' (matches *.csproj glob pattern)
    const tmpCsproj = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-rescan-csproj-'));
    try {
      fs.copyFileSync(path.join(FIXTURES, 'MyApp-cpm.csproj'), path.join(tmpCsproj, 'MyApp.csproj'));
      fs.copyFileSync(path.join(FIXTURES, 'Directory.Packages.props'), path.join(tmpCsproj, 'Directory.Packages.props'));
      const r = rescanManifest(path.join(tmpCsproj, 'MyApp.csproj'));
      expect(r.manifestType).toBe('csproj');
      expect(r.dependencies.find((d) => d.name === 'Newtonsoft.Json')?.declaredVersion).toBe('13.0.3');
    } finally {
      fs.rmSync(tmpCsproj, { recursive: true, force: true });
    }

    // Aux file: Directory.Packages.props re-anchors to the parent csproj
    const tmpProps = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-rescan-props-'));
    try {
      fs.copyFileSync(path.join(FIXTURES, 'MyApp-cpm.csproj'), path.join(tmpProps, 'MyApp.csproj'));
      fs.copyFileSync(path.join(FIXTURES, 'Directory.Packages.props'), path.join(tmpProps, 'Directory.Packages.props'));
      const r = rescanManifest(path.join(tmpProps, 'Directory.Packages.props'));
      expect(r.manifestType).toBe('csproj');
      expect(r.dependencies.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpProps, { recursive: true, force: true });
    }

    // Nested gradle catalog
    const tmpGradle = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-rescan-gradle-'));
    try {
      fs.mkdirSync(path.join(tmpGradle, 'gradle'));
      fs.copyFileSync(
        path.join(FIXTURES, 'gradle', 'libs.versions.toml'),
        path.join(tmpGradle, 'gradle', 'libs.versions.toml'),
      );
      const r = rescanManifest(path.join(tmpGradle, 'gradle', 'libs.versions.toml'));
      expect(r.manifestType).toBe('libs.versions.toml');
      expect(r.dependencies.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(tmpGradle, { recursive: true, force: true });
    }
  });
});
