/**
 * Project scanner. Walks up from a starting directory to find the first
 * recognised manifest, parses it, and returns the dependency list.
 *
 * Adversarial-input hardening (security-critical, since we run inside a user's
 * project): reject symlinks, FIFOs, devices, sockets; cap manifest size at
 * 1 MB; reject UTF-16 / binary content via a NUL-byte check.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import TOML from '@iarna/toml';
import { globSync } from 'tinyglobby';
import { parse as parseYaml } from 'yaml';

import { Dependency, ManifestError, ManifestType, ProjectScan } from '../types.js';
import { parsePackageJson } from '../adapters/manifests/package_json.js';
import { parseRequirementsTxt } from '../adapters/manifests/requirements_txt.js';
import { parsePyprojectToml } from '../adapters/manifests/pyproject_toml.js';
import { parseGoMod } from '../adapters/manifests/go_mod.js';
import { parseCargoToml } from '../adapters/manifests/cargo_toml.js';
import { parseComposerJson } from '../adapters/manifests/composer_json.js';
import { parsePomXml, extractBomImports, extractAggregatorModules, extractParentCoords } from '../adapters/manifests/pom_xml.js';
import { parseGradleVersionsToml } from '../adapters/manifests/gradle_versions_toml.js';
import { parseGemfile, parseGemfileLock } from '../adapters/manifests/ruby.js';
import { parseCsprojXml } from '../adapters/manifests/csproj_xml.js';
import { parseDirectoryPackagesProps } from '../adapters/manifests/directory_packages_props.js';
import { parseSln } from '../adapters/manifests/sln.js';
import { parseSettingsGradle } from '../adapters/manifests/settings_gradle.js';
import { parseBuildGradle, extractPluginIds } from '../adapters/manifests/build_gradle.js';
import { resolveGradlePluginCoord } from '../data/gradle_plugin_coords.js';
import { parseGoWork } from '../adapters/manifests/go_work.js';
import {
  INCLUDE_DEV_DEPS_DEFAULT,
  MAX_MANIFEST_BYTES,
  MAX_WALK_DEPTH,
  MAX_WORKSPACE_MEMBERS,
} from '../config.js';
import { getLogger } from '../logging.js';

export interface ScanOpts {
  /**
   * v2.2: when true, include devDependencies / dev-dependencies / require-dev
   * in the result. Defaults to INCLUDE_DEV_DEPS_DEFAULT (env-derived; false
   * unless CODEWIKI_INCLUDE_DEV_DEPS=1 is set).
   */
  includeDev?: boolean;
  /**
   * v2.8: when true, include npm optionalDependencies tagged `kind: 'optional'`.
   * Only the package.json parser consumes this today; other parsers ignore it.
   * Tool default is true (list_project_dependencies), parser-level default is
   * false for back-compat — call sites must opt in explicitly.
   */
  includeOptional?: boolean;
}

type ParserFn = (source: string, opts?: ScanOpts) => Dependency[];

/**
 * v2.3: discriminated manifest entry. Three matcher kinds:
 *   - 'basename'  — exact filename in the candidate dir (v1/v2/v2.2 behavior).
 *   - 'nested'    — relative subpath from the candidate dir (e.g.
 *                   `gradle/libs.versions.toml`).
 *   - 'glob'      — glob pattern matched in the candidate dir, returning ALL
 *                   matches (e.g. `*.csproj`). Glob is constrained to the
 *                   immediate dir; recursive `**` patterns are NOT used.
 *
 * `tier` reflects manifest specificity. Canonical manifests (`pom.xml`,
 * `Cargo.toml`, language-uniquely-identifying) MUST be ordered before aux
 * manifests (`requirements.txt`, `gradle/libs.versions.toml`, `Gemfile`) so a
 * Spring Boot repo with a docs-site `package.json` resolves as `pom.xml`.
 * The actual order is the array's declaration order; tier metadata documents
 * the intent and asserts the invariant in tests.
 */
type ManifestMatcher = 'basename' | 'glob' | 'nested';
type ManifestTier = 'canonical' | 'aux';

interface ManifestPriorityEntry {
  type: ManifestType;
  matcher: ManifestMatcher;
  pattern: string;
  tier: ManifestTier;
}

// Priority order: canonical entries first, then aux. Within each tier, the
// order is preserved from v1/v2/v2.2 to keep existing behavior intact.
// New ecosystem entries (pom.xml, csproj, libs.versions.toml, Gemfile.lock,
// Gemfile) are appended in Tasks 3-5 with their explicit positioning.
const MANIFEST_PRIORITY: ManifestPriorityEntry[] = [
  // canonical tier — pom.xml first so a Spring Boot repo with a docs-site
  // package.json resolves as pom.xml (Claude review §5).
  { type: 'pom.xml', matcher: 'basename', pattern: 'pom.xml', tier: 'canonical' },
  // v2.4: *.sln BEFORE csproj — handles solution-root cwd where root has
  // no *.csproj (the dominant IDE invocation for .NET monorepos).
  { type: 'sln', matcher: 'glob', pattern: '*.sln', tier: 'canonical' },
  // *.csproj — glob match. Multi-csproj small-monorepo case is aggregated.
  // Stays HIGH in canonical tier so a .NET project with sibling package.json
  // resolves as csproj.
  { type: 'csproj', matcher: 'glob', pattern: '*.csproj', tier: 'canonical' },
  { type: 'Cargo.toml', matcher: 'basename', pattern: 'Cargo.toml', tier: 'canonical' },
  { type: 'composer.json', matcher: 'basename', pattern: 'composer.json', tier: 'canonical' },
  // v2.4: go.work BEFORE go.mod — a Go workspace's go.work supersedes its
  // go.mod as the project root.
  { type: 'go.work', matcher: 'basename', pattern: 'go.work', tier: 'canonical' },
  { type: 'go.mod', matcher: 'basename', pattern: 'go.mod', tier: 'canonical' },
  { type: 'pyproject.toml', matcher: 'basename', pattern: 'pyproject.toml', tier: 'canonical' },
  { type: 'package.json', matcher: 'basename', pattern: 'package.json', tier: 'canonical' },
  // Gemfile.lock is canonical (deterministic source of truth for direct deps).
  { type: 'Gemfile.lock', matcher: 'basename', pattern: 'Gemfile.lock', tier: 'canonical' },
  // aux tier — secondary / catalog / regex-DSL manifests.
  { type: 'requirements.txt', matcher: 'basename', pattern: 'requirements.txt', tier: 'aux' },
  { type: 'libs.versions.toml', matcher: 'nested', pattern: 'gradle/libs.versions.toml', tier: 'aux' },
  // Gemfile is the regex-DSL fallback when Gemfile.lock is absent.
  { type: 'Gemfile', matcher: 'basename', pattern: 'Gemfile', tier: 'aux' },
];

const PARSER_BY_TYPE: Partial<Record<ManifestType, ParserFn>> = {
  'package.json': parsePackageJson,
  'pyproject.toml': parsePyprojectToml,
  'requirements.txt': parseRequirementsTxt,
  'go.mod': parseGoMod,
  'Cargo.toml': parseCargoToml,
  'composer.json': parseComposerJson,
  'pom.xml': parsePomXml,
  'libs.versions.toml': parseGradleVersionsToml,
  'Gemfile.lock': parseGemfileLock,
  'Gemfile': parseGemfile,
  'csproj': parseCsprojXml,
};

/**
 * Match a single manifest entry against a directory. Returns the absolute
 * paths of the file(s) the entry matches, or null when no match.
 *
 * - basename / nested: at most one path (or null).
 * - glob: zero, one, or many paths (when zero, returns null).
 */
function matchManifestInDir(dir: string, entry: ManifestPriorityEntry): string[] | null {
  switch (entry.matcher) {
    case 'basename':
    case 'nested': {
      const candidate = path.join(dir, entry.pattern);
      return fs.existsSync(candidate) ? [candidate] : null;
    }
    case 'glob': {
      const matches = globSync([entry.pattern], {
        cwd: dir,
        absolute: true,
        onlyFiles: true,
      });
      return matches.length > 0 ? matches.sort() : null;
    }
  }
}

/**
 * Apply hardening to a candidate manifest path: lstat (no symlink follow),
 * size cap, NUL-byte content check. Throws ManifestError on violation.
 * Returns the file source on success.
 */
function readManifestSafely(manifestType: ManifestType, candidate: string): string {
  const stats = fs.lstatSync(candidate);
  if (!stats.isFile()) {
    let why = 'not a regular file';
    if (stats.isSymbolicLink()) why = 'symbolic link (v1 does not follow symlinks)';
    else if (stats.isFIFO()) why = 'FIFO / named pipe';
    else if (stats.isCharacterDevice()) why = 'character device';
    else if (stats.isBlockDevice()) why = 'block device';
    else if (stats.isSocket()) why = 'socket';
    else if (stats.isDirectory()) why = 'directory';
    throw new ManifestError(
      'unsafe_manifest',
      `${manifestType} at ${candidate} is ${why} — refusing to read`,
      candidate,
    );
  }
  if (stats.size > MAX_MANIFEST_BYTES) {
    throw new ManifestError(
      'manifest_too_large',
      `${manifestType} at ${candidate} is ${stats.size} bytes (limit ${MAX_MANIFEST_BYTES})`,
      candidate,
    );
  }
  const source = fs.readFileSync(candidate, { encoding: 'utf8' });
  if (source.indexOf('\0') >= 0) {
    throw new ManifestError(
      'invalid_encoding',
      `${manifestType} at ${candidate} contains a NUL byte (likely UTF-16 or binary)`,
      candidate,
    );
  }
  return source;
}

/**
 * v2.3: walk UP from the csproj dir looking for `Directory.Packages.props`.
 * Stops at: home dir, filesystem root, a dir containing `.git`, or
 * `MAX_WALK_DEPTH` levels. Returns the absolute path on hit, null on miss.
 * Hardening (lstat / size / NUL) applied to the discovered file.
 */
function findDirectoryPackagesProps(csprojDir: string): string | null {
  const home = os.homedir();
  let dir = path.resolve(csprojDir);
  let depth = 0;
  while (depth < MAX_WALK_DEPTH) {
    const candidate = path.join(dir, 'Directory.Packages.props');
    if (fs.existsSync(candidate)) {
      // Apply same hardening as any other manifest read.
      readManifestSafely('Directory.Packages.props', candidate);
      return candidate;
    }
    // Repo-root sentinel — MSBuild typically doesn't search above .git.
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    if (dir === home) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    depth++;
  }
  return null;
}

/**
 * v2.4: walk UP from a starting dir looking for any `*.sln`. Stops at: home
 * dir, filesystem root, a dir containing `.git`, or `MAX_WALK_DEPTH` levels.
 * Returns the lex-first sln on hit (warn-log when multiple at same level), or
 * null on miss.
 */
function findUpwardSln(startDir: string): string | null {
  const home = os.homedir();
  let dir = path.resolve(startDir);
  let depth = 0;
  while (depth < MAX_WALK_DEPTH) {
    const matches = globSync(['*.sln'], { cwd: dir, absolute: true, onlyFiles: true });
    if (matches.length > 0) {
      const sorted = [...matches].sort();
      if (sorted.length > 1) {
        getLogger().warn('sln_multiple_at_level', { dir, count: sorted.length });
      }
      return sorted[0];
    }
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    if (dir === home) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    depth++;
  }
  return null;
}

/**
 * v2.4: shared core — read each csproj, dedup PackageReferences by Include,
 * apply CPM upward walk anchored on `cpmAnchor`. Returns merged deps + the
 * resolved Directory.Packages.props path (or null).
 */
function mergeCsprojsAndCpm(
  csprojPaths: string[],
  cpmAnchor: string,
  opts: ScanOpts,
): { deps: Dependency[]; propsPath: string | null } {
  const seen = new Set<string>();
  const merged: Dependency[] = [];
  for (const csprojPath of csprojPaths) {
    const source = readManifestSafely('csproj', csprojPath);
    const deps = parseCsprojXml(source, opts);
    for (const d of deps) {
      const key = `${d.name}\x00${d.ecosystem}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(d);
    }
  }
  const propsPath = findDirectoryPackagesProps(cpmAnchor);
  if (propsPath) {
    const propsSource = readManifestSafely('Directory.Packages.props', propsPath);
    const versionMap = parseDirectoryPackagesProps(propsSource);
    for (const d of merged) {
      if (d.declaredVersion === undefined) {
        const v = versionMap.get(d.name);
        if (v) d.declaredVersion = v;
      }
    }
  }
  merged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { deps: merged, propsPath };
}

/**
 * v2.4: dispatched by both the top-level `*.sln` priority entry and the
 * csproj-branch upward walk. Parses sln, resolves listed csprojs to absolute
 * paths within slnDir, applies safety checks, and merges via the shared
 * `mergeCsprojsAndCpm`. CPM anchor:
 *   - top-level path: defaults to first sln-listed csproj's dir.
 *   - csproj-branch path: caller passes `cpmAnchorOverride = original csproj dir`.
 *
 * `manifestType` is always 'sln' on success — both entry paths converge on
 * the same handler. The originally matched csproj path (when called from the
 * csproj branch) goes into `extraManifestFiles` so the watcher tracks it.
 */
function handleSlnDispatch(
  slnPath: string,
  projectRoot: string,
  opts: ScanOpts,
  cpmAnchorOverride: string | null,
): ProjectScan | null {
  // Returns null when the sln yields zero usable csprojs (corrupt / empty /
  // all listed paths missing). Callers decide the fallback:
  //   - top-level entry: emit empty-deps scan with manifestType='sln'
  //   - csproj-branch: fall through to v2.3 dir-only csproj-glob behavior
  //   (Codex M2 v2.4-verify finding — corrupt sln must not silently swallow
  //   a valid deep-cwd csproj scan).
  const log = getLogger();
  const slnSource = readManifestSafely('sln', slnPath);
  const csprojRels = parseSln(slnSource);
  if (csprojRels.length === 0) {
    log.warn('sln_no_csprojs_listed', { sln: slnPath });
    return null;
  }
  const slnDir = path.dirname(slnPath);
  const sep = path.sep;
  const csprojAbs: string[] = [];
  for (const rel of csprojRels) {
    const abs = path.resolve(slnDir, rel);
    if (!abs.startsWith(slnDir + sep)) {
      log.warn('sln_csproj_escape', { sln: slnPath, rel });
      continue;
    }
    if (!fs.existsSync(abs)) {
      log.warn('sln_csproj_missing', { sln: slnPath, rel });
      continue;
    }
    csprojAbs.push(abs);
  }
  if (csprojAbs.length === 0) {
    return null;
  }

  const cpmAnchor = cpmAnchorOverride ?? path.dirname(csprojAbs[0]);
  const { deps, propsPath } = mergeCsprojsAndCpm(csprojAbs, cpmAnchor, opts);

  const matchedManifestPath = csprojAbs[0];
  const extraManifestFiles: string[] = [slnPath, ...csprojAbs.slice(1)];
  if (propsPath) extraManifestFiles.push(propsPath);

  const result: ProjectScan = {
    projectRoot,
    manifestType: 'sln',
    dependencies: deps,
    matchedManifestPath,
  };
  if (extraManifestFiles.length > 0) {
    result.extraManifestFiles = extraManifestFiles;
  }
  return result;
}

/**
 * v2.3: csproj branch handler — aggregates ALL matched *.csproj files in the
 * dir, dedups by (name, ecosystem) first-wins, applies CPM merge via the
 * upward-discovered Directory.Packages.props, and populates the v2.3
 * matchedManifestPath / extraManifestFiles fields.
 *
 * v2.4: BEFORE the dir-only csproj-glob processing, walk upward for `*.sln`.
 * If found, dispatch to `handleSlnDispatch` with `cpmAnchorOverride = dir`
 * (preserves v2.3 CPM semantics: walk anchors on originally matched csproj).
 */
function handleCsprojMatch(
  dir: string,
  matchedPaths: string[],
  opts: ScanOpts,
): ProjectScan {
  const slnPath = findUpwardSln(dir);
  if (slnPath !== null) {
    const dispatched = handleSlnDispatch(slnPath, dir, opts, dir);
    if (dispatched !== null) return dispatched;
    // Codex M2 v2.4-verify: sln yielded zero usable csprojs (empty / corrupt
    // / all paths missing). Fall through to v2.3 dir-only csproj-glob path
    // so a deep-cwd scan below a corrupt solution still returns valid deps.
  }
  // Truncate at MAX_WORKSPACE_MEMBERS to bound chokidar handle count for
  // pathological repos with hundreds of csprojs in one dir.
  let candidates = matchedPaths;
  if (candidates.length > MAX_WORKSPACE_MEMBERS) {
    getLogger().warn('csproj_glob_truncated', {
      total: candidates.length,
      kept: MAX_WORKSPACE_MEMBERS,
      dropped: candidates.length - MAX_WORKSPACE_MEMBERS,
    });
    candidates = candidates.slice(0, MAX_WORKSPACE_MEMBERS);
  }

  const seen = new Set<string>();
  const merged: Dependency[] = [];
  for (const csprojPath of candidates) {
    const source = readManifestSafely('csproj', csprojPath);
    const deps = parseCsprojXml(source, opts);
    for (const d of deps) {
      const key = `${d.name}\x00${d.ecosystem}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(d);
    }
  }

  // CPM merge — upward walk for Directory.Packages.props.
  const propsPath = findDirectoryPackagesProps(dir);
  if (propsPath) {
    const propsSource = readManifestSafely('Directory.Packages.props', propsPath);
    const versionMap = parseDirectoryPackagesProps(propsSource);
    for (const d of merged) {
      if (d.declaredVersion === undefined) {
        const v = versionMap.get(d.name);
        if (v) d.declaredVersion = v;
      }
    }
  }

  merged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const matchedManifestPath = candidates[0];
  const extraCsprojFiles = candidates.slice(1);
  const extraManifestFiles: string[] = [...extraCsprojFiles];
  if (propsPath) extraManifestFiles.push(propsPath);

  const result: ProjectScan = {
    projectRoot: dir,
    manifestType: 'csproj',
    dependencies: merged,
    matchedManifestPath,
  };
  if (extraManifestFiles.length > 0) {
    result.extraManifestFiles = extraManifestFiles;
  }
  return result;
}

export function scanProject(startDir: string, opts?: ScanOpts): ProjectScan {
  // Resolve effective options (explicit arg wins; env-derived default otherwise).
  const effective: ScanOpts = {
    includeDev: opts?.includeDev ?? INCLUDE_DEV_DEPS_DEFAULT,
    includeOptional: opts?.includeOptional ?? false,
  };
  return scanProjectWithOpts(startDir, effective);
}

function scanProjectWithOpts(startDir: string, opts: ScanOpts): ProjectScan {
  const home = os.homedir();
  let dir = path.resolve(startDir);
  let depth = 0;

  while (depth < MAX_WALK_DEPTH) {
    const result = scanAtDir(dir, opts);
    if (result) return result;

    // Stop conditions: at home dir, at filesystem root, or at depth ceiling.
    if (dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }

  return { projectRoot: null, manifestType: null, dependencies: [] };
}

/**
 * v2.3: ONE iteration of the manifest scan at a known directory. No walk-up.
 * Returns null when no manifest matches at this dir; the caller decides
 * whether to walk up (scanProject) or give up (rescanFromRoot).
 *
 * Extracted from scanProjectWithOpts so the watcher's `rescanFromRoot`
 * shares the same dispatch logic — including the v2.3 csproj branch
 * (multi-csproj + CPM upward walk) and JS workspace traversal.
 */
function scanAtDir(dir: string, opts: ScanOpts): ProjectScan | null {
  for (const entry of MANIFEST_PRIORITY) {
    const matchedPaths = matchManifestInDir(dir, entry);
    if (!matchedPaths || matchedPaths.length === 0) continue;

    // v2.4: top-level *.sln entry — handles solution-root cwd where the
    // root has no *.csproj. cpmAnchorOverride=null → CPM anchors on first
    // sln-listed csproj's dir (no original csproj to anchor on). When the
    // sln is corrupt / empty (returns null), emit empty-deps scan with
    // manifestType='sln' (no csproj fallback at this level since the cwd
    // is the solution root which has no csproj).
    if (entry.type === 'sln') {
      const dispatched = handleSlnDispatch(matchedPaths[0], dir, opts, null);
      if (dispatched !== null) return dispatched;
      return {
        projectRoot: dir,
        manifestType: 'sln',
        dependencies: [],
        matchedManifestPath: matchedPaths[0],
      };
    }

    // v2.4: go.work workspace traversal. Aggregates per-member go.mod deps
    // into a single ProjectScan; surfaces use dirs through workspaceMembers.
    if (entry.type === 'go.work') {
      return handleGoWorkMatch(dir, matchedPaths[0], opts);
    }

    // v2.3: csproj branch — multi-csproj aggregation + CPM upward walk.
    // v2.4: branch internally does upward sln walk first.
    if (entry.type === 'csproj') {
      return handleCsprojMatch(dir, matchedPaths, opts);
    }

    const primaryPath = matchedPaths[0];
    const source = readManifestSafely(entry.type, primaryPath);

    const parser = PARSER_BY_TYPE[entry.type];
    if (!parser) {
      throw new ManifestError(
        'unsupported_format',
        `${entry.type} parser not registered`,
        primaryPath,
      );
    }
    const dependencies = parser(source, opts);

    // v2.2: Cargo workspace traversal.
    if (entry.type === 'Cargo.toml') {
      const ws = traverseCargoWorkspace(dir, source, opts);
      if (ws) {
        const merged = mergeWorkspace(dir, entry.type, dependencies, ws);
        merged.matchedManifestPath = primaryPath;
        return merged;
      }
    }

    // v2.5: Gradle subproject discovery + per-subproject build.gradle parsing
    // (renamed from v2.4's discoverGradleSubprojects which was discovery-only).
    if (entry.type === 'libs.versions.toml') {
      const gradleResult = discoverGradleProjects(dir, dependencies, opts);
      if (gradleResult !== null) {
        gradleResult.matchedManifestPath = primaryPath;
        return gradleResult;
      }
    }

    // v2.3: JS workspace traversal.
    if (entry.type === 'package.json') {
      const jsWs = traverseJsWorkspaces(dir, source, opts);
      if (jsWs) {
        const merged = mergeJsWorkspace(dir, dependencies, jsWs);
        merged.matchedManifestPath = primaryPath;
        return merged;
      }
    }

    let result: ProjectScan = {
      projectRoot: dir,
      manifestType: entry.type,
      dependencies,
      matchedManifestPath: primaryPath,
    };

    // v2.4: pom.xml aggregator-modules traversal — supersedes the simple
    // single-pom path when packaging=pom AND <modules> is present.
    if (entry.type === 'pom.xml') {
      const moduleDirs = extractAggregatorModules(source);
      if (moduleDirs !== null) {
        const ws = traverseAggregatorPom(dir, moduleDirs, opts);
        result = mergeAggregatorPom(dir, dependencies, ws);
        result.matchedManifestPath = primaryPath;
      }
    }

    // v2.4: pom.xml BOM-import side-channel (parser is pure; scanner attaches).
    if (entry.type === 'pom.xml') {
      const boms = extractBomImports(source);
      if (boms.length > 0) result.bomImports = boms;
    }

    // v2.5: pom.xml parent-coords side-channel (parser is pure; scanner attaches).
    // The tool layer's enrichWithParentPom fetches the parent POM and patches
    // declaredVersion entries from the parent's literal <dependencyManagement>
    // AND appends the parent's nested <scope>import</scope> BOMs onto bomImports
    // so the recursive bom_resolver walker resolves them at depth 0.
    if (entry.type === 'pom.xml') {
      const parent = extractParentCoords(source);
      if (parent !== null) result.parentCoords = parent;
    }

    return result;
  }
  return null;
}

/**
 * v2.3: re-run scanAtDir from a KNOWN project root with NO walk-up. Used by
 * the manifest watcher so any change to a watched file (canonical manifest,
 * workspace member manifest, or aux file like `Directory.Packages.props` /
 * `pnpm-workspace.yaml`) re-runs the full v2.3 dispatch — multi-csproj+CPM,
 * JS workspace traversal, Cargo glob expansion, etc. — instead of failing
 * the basename-only lookup that v2.2's `rescanManifest` did.
 */
export function rescanFromRoot(projectRoot: string, opts?: ScanOpts): ProjectScan {
  const effective: ScanOpts = {
    includeDev: opts?.includeDev ?? INCLUDE_DEV_DEPS_DEFAULT,
    includeOptional: opts?.includeOptional ?? false,
  };
  const result = scanAtDir(path.resolve(projectRoot), effective);
  return result ?? { projectRoot: null, manifestType: null, dependencies: [] };
}

// v2.3: aux file basenames the watcher observes that are NOT canonical
// project manifests themselves — they invalidate cached deps via the parent
// canonical manifest's rescan. `Directory.Packages.props` (CPM) and
// `pnpm-workspace.yaml` are the v2.3 cases.
const AUX_MANIFEST_BASENAMES = new Set([
  'Directory.Packages.props',
  'pnpm-workspace.yaml',
]);

/**
 * v2.2/v2.3: re-parse a known manifest path WITHOUT walking upward.
 *
 * Used by `manifest_watcher.ts` so editor save-rename races never silently
 * switch the watcher onto a parent directory's manifest. When the file is
 * mid-rename and ENOENT, returns `prev` (caller's last known good scan) so
 * callers can keep state through the gap.
 *
 * v2.3 (Codex H1 + Claude must_fix): supports glob (csproj), nested (gradle
 * catalog), and aux (Directory.Packages.props, pnpm-workspace.yaml) paths
 * by re-anchoring to the appropriate project root and delegating to
 * `rescanFromRoot`. The basename-only lookup that worked for v2.2 throws
 * `unsupported_format` for these v2.3 paths; the watcher silently dropped
 * cache invalidation for csproj / gradle / CPM / pnpm edits.
 */
export function rescanManifest(
  manifestPath: string,
  opts?: ScanOpts,
  prev?: ProjectScan,
): ProjectScan {
  const effective: ScanOpts = {
    includeDev: opts?.includeDev ?? INCLUDE_DEV_DEPS_DEFAULT,
    includeOptional: opts?.includeOptional ?? false,
  };

  const basename = path.basename(manifestPath);

  // Find the matching entry. Three matchers, plus the v2.3 aux-file case.
  const entry = MANIFEST_PRIORITY.find((e) => {
    if (e.matcher === 'basename') return e.pattern === basename;
    if (e.matcher === 'glob') {
      // pattern like '*.csproj' — match by extension
      if (e.pattern.startsWith('*.')) return basename.endsWith(e.pattern.slice(1));
      return false;
    }
    if (e.matcher === 'nested') {
      // pattern like 'gradle/libs.versions.toml' — match by trailing path segments
      const norm = manifestPath.replace(/\\/g, '/');
      return norm.endsWith('/' + e.pattern) || norm === e.pattern;
    }
    return false;
  });
  const isAuxFile = AUX_MANIFEST_BASENAMES.has(basename);

  if (!entry && !isAuxFile) {
    throw new ManifestError(
      'unsupported_format',
      `${basename} is not a recognised manifest type`,
      manifestPath,
    );
  }

  if (!fs.existsSync(manifestPath)) {
    if (prev) return prev;
    return { projectRoot: null, manifestType: null, dependencies: [] };
  }

  // Derive the project root from the matched entry's path shape:
  //   basename / glob:        projectRoot = path.dirname(manifestPath)
  //   nested ('a/b/c.toml'):  projectRoot = strip the nested-pattern segments
  //   aux file:               projectRoot = path.dirname(manifestPath); the
  //                            scanner finds the parent canonical manifest
  let projectRoot: string;
  if (entry?.matcher === 'nested') {
    const segments = entry.pattern.split('/').length;
    projectRoot = manifestPath;
    for (let i = 0; i < segments; i++) projectRoot = path.dirname(projectRoot);
  } else {
    projectRoot = path.dirname(manifestPath);
  }

  return rescanFromRoot(projectRoot, effective);
}

interface WorkspaceResult {
  members: string[];
  deps: Dependency[];
}

const GLOB_CHARS = /[*?[\]]|^!/;

/**
 * v2.3: pre-expansion safety filter for user-supplied workspace glob
 * patterns (Cargo `members`, JS `workspaces`, pnpm `pnpm-workspace.yaml`).
 * Rejects: absolute paths (`/etc/*`), parent-escape segments (`../foo`),
 * recursive globstar (`**`). Rejected patterns produce a warn-log and are
 * dropped — `tinyglobby` is never asked to expand them.
 *
 * Returns { safe, rejected } where `safe` is the pass-through list (preserves
 * negation `!foo`, single-level globs `crates/*`, literal paths).
 */
function applyGlobSafetyFilter(
  patterns: string[],
  ecosystem: string,
): { safe: string[]; rejected: Array<{ pattern: string; reason: string }> } {
  const safe: string[] = [];
  const rejected: Array<{ pattern: string; reason: string }> = [];
  for (const p of patterns) {
    if (typeof p !== 'string' || p.length === 0) continue;
    // Strip leading `!` for safety check; preserve it on the safe pattern.
    const negated = p.startsWith('!');
    const body = negated ? p.slice(1) : p;
    if (body.startsWith('/')) {
      rejected.push({ pattern: p, reason: 'absolute' });
      continue;
    }
    if (body.split(/[\\/]/).includes('..')) {
      rejected.push({ pattern: p, reason: 'parent-segment' });
      continue;
    }
    if (body.includes('**')) {
      rejected.push({ pattern: p, reason: 'recursive-globstar' });
      continue;
    }
    safe.push(p);
  }
  if (rejected.length > 0) {
    const log = getLogger();
    for (const r of rejected) {
      log.warn(`${ecosystem}_workspace_glob_pattern_rejected`, r);
    }
  }
  return { safe, rejected };
}

const WORKSPACE_GLOB_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/target/**',
  '**/dist/**',
  '**/build/**',
];

function traverseCargoWorkspace(
  projectRoot: string,
  rootSource: string,
  opts: ScanOpts,
): WorkspaceResult | null {
  let parsed: unknown;
  try {
    parsed = TOML.parse(rootSource);
  } catch {
    // The Cargo.toml parser already threw; if it didn't, just bail on workspace traversal.
    return null;
  }

  const ws = (parsed as { workspace?: { members?: unknown } }).workspace;
  if (!ws || typeof ws !== 'object') return null;
  const members = ws.members;
  if (!Array.isArray(members)) return null;

  const log = getLogger();
  const resolvedRoot = path.resolve(projectRoot);
  // Realpath the project root too — on macOS, os.tmpdir() returns `/var/...`
  // but `fs.realpathSync` resolves to `/private/var/...`. Without realpathing
  // both sides, every member realpath check would falsely fail in temp dirs.
  const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
  const sep = path.sep;

  // v2.3: split into literal vs glob, apply safety filter to globs, then
  // expand surviving globs via tinyglobby with built-in ignores.
  const stringMembers: string[] = members.filter((m): m is string => typeof m === 'string');
  const literalMembers: string[] = [];
  const globPatterns: string[] = [];
  for (const m of stringMembers) {
    if (GLOB_CHARS.test(m)) globPatterns.push(m);
    else literalMembers.push(m);
  }
  const { safe: safeGlobs } = applyGlobSafetyFilter(globPatterns, 'cargo');
  let expandedFromGlob: string[] = [];
  if (safeGlobs.length > 0) {
    const matches = globSync(safeGlobs, {
      cwd: resolvedRoot,
      absolute: true,
      onlyFiles: false,
      ignore: WORKSPACE_GLOB_IGNORES,
    });
    if (matches.length === 0) {
      log.info('cargo_workspace_glob_no_matches', { patterns: safeGlobs });
    }
    // Convert absolute glob results back to relative member paths so the
    // downstream loop's `path.resolve(resolvedRoot, m, 'Cargo.toml')` works
    // identically for both literal and expanded entries.
    const seenExpanded = new Set<string>();
    for (const abs of matches) {
      if (!abs.startsWith(resolvedRoot + sep)) continue;
      const rel = path.relative(resolvedRoot, abs);
      if (rel.length > 0 && !seenExpanded.has(rel)) {
        seenExpanded.add(rel);
        expandedFromGlob.push(rel);
      }
    }
  }

  // Truncate (do NOT throw) when over the cap. Apply AFTER glob expansion so
  // the cap bounds total per-member parsing work regardless of expansion size.
  let candidates = [...literalMembers, ...expandedFromGlob];
  if (candidates.length > MAX_WORKSPACE_MEMBERS) {
    log.warn('cargo_workspace_members_truncated', {
      total: candidates.length,
      kept: MAX_WORKSPACE_MEMBERS,
      dropped: candidates.length - MAX_WORKSPACE_MEMBERS,
    });
    candidates = candidates.slice(0, MAX_WORKSPACE_MEMBERS);
  }

  const acceptedMembers: string[] = [];
  const memberDeps: Dependency[] = [];

  for (const m of candidates) {
    const joined = path.resolve(resolvedRoot, m, 'Cargo.toml');

    // Stage 1: lexical prefix check (defends against `members = ["../../etc"]`).
    if (!joined.startsWith(resolvedRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `workspace member ${m} escapes project root before symlink resolution`,
        m,
      );
    }

    // Skip if file doesn't exist (typo in members) — warn-log only.
    if (!fs.existsSync(joined)) {
      log.warn('cargo_workspace_member_missing', { member: m });
      continue;
    }

    // Stage 2: realpath check (defends against a symlink whose target leaves the project).
    // Compare realpath-of-member against realpath-of-projectRoot so macOS
    // /var → /private/var symlink resolution doesn't false-positive temp-dir cases.
    const real = fs.realpathSync(joined);
    if (!real.startsWith(realRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `workspace member ${m} symlink target escapes project root`,
        m,
      );
    }

    // Hardening: reuse the same lstat / size / NUL checks as the root scanner.
    const stats = fs.lstatSync(joined);
    if (!stats.isFile()) {
      throw new ManifestError(
        'unsafe_manifest',
        `workspace member Cargo.toml at ${joined} is not a regular file`,
        joined,
      );
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      throw new ManifestError(
        'manifest_too_large',
        `workspace member Cargo.toml at ${joined} is ${stats.size} bytes`,
        joined,
      );
    }
    const memberSource = fs.readFileSync(joined, { encoding: 'utf8' });
    if (memberSource.indexOf(' ') >= 0) {
      throw new ManifestError(
        'invalid_encoding',
        `workspace member Cargo.toml at ${joined} contains a NUL byte`,
        joined,
      );
    }

    // Parse — parse_error throws (fail closed for hardening / parsing violations).
    const parsed = parseCargoToml(memberSource, opts);
    acceptedMembers.push(m);
    for (const d of parsed) memberDeps.push(d);
  }

  return { members: acceptedMembers, deps: memberDeps };
}

/**
 * v2.3: JS workspace traversal. Honors:
 *   - `pnpm-workspace.yaml` (`packages: [...]`) — TRUMPS package.json:workspaces.
 *   - root `package.json:workspaces` as string[] OR { packages: string[] }.
 *
 * Pre-expansion safety filter rejects `**`/`/`-absolute/`..`-segment patterns.
 * Path separators normalized to forward slashes (Windows-edited yaml).
 * Negation (`!packages/excluded`) honored.
 *
 * Returns null when no workspace declaration is present.
 */
function traverseJsWorkspaces(
  projectRoot: string,
  rootSource: string,
  opts: ScanOpts,
): { members: string[]; deps: Dependency[]; pnpmWorkspaceYamlPath?: string } | null {
  const log = getLogger();
  const resolvedRoot = path.resolve(projectRoot);
  const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
  const sep = path.sep;

  // Detect patterns: pnpm trumps; falls back to package.json:workspaces.
  let patterns: string[] | null = null;
  let pnpmYamlPath: string | undefined;
  const pnpmYaml = path.join(resolvedRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmYaml)) {
    // Inline hardening (3 lines) so error messages correctly attribute the
    // file path — Claude review §8: reusing readManifestSafely with the
    // 'package.json' label would mis-attribute pnpm-workspace.yaml errors.
    const stats = fs.lstatSync(pnpmYaml);
    if (!stats.isFile()) {
      throw new ManifestError('unsafe_manifest', `pnpm-workspace.yaml at ${pnpmYaml} is not a regular file`, pnpmYaml);
    }
    if (stats.size > MAX_MANIFEST_BYTES) {
      throw new ManifestError('manifest_too_large', `pnpm-workspace.yaml at ${pnpmYaml} is ${stats.size} bytes`, pnpmYaml);
    }
    const pnpmSource = fs.readFileSync(pnpmYaml, { encoding: 'utf8' });
    if (pnpmSource.indexOf('\0') >= 0) {
      throw new ManifestError('invalid_encoding', `pnpm-workspace.yaml at ${pnpmYaml} contains a NUL byte`, pnpmYaml);
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(pnpmSource);
    } catch (err) {
      throw new ManifestError(
        'parse_error',
        `pnpm-workspace.yaml: ${err instanceof Error ? err.message : String(err)}`,
        pnpmYaml,
      );
    }
    const pkgs = (parsed as { packages?: unknown })?.packages;
    if (pkgs === undefined || pkgs === null) {
      // pnpm 9+ allows pnpm-workspace.yaml with only `allowBuilds:` (or other
      // non-workspace fields). Missing `packages:` = no workspace defined;
      // fall through to package.json:workspaces detection below.
      return null;
    }
    if (!Array.isArray(pkgs) || pkgs.some((p) => typeof p !== 'string')) {
      throw new ManifestError(
        'parse_error',
        'pnpm-workspace.yaml: `packages` must be an array of strings',
        pnpmYaml,
      );
    }
    patterns = pkgs as string[];
    pnpmYamlPath = pnpmYaml;
  } else {
    let pkgJson: unknown;
    try {
      pkgJson = JSON.parse(rootSource);
    } catch {
      return null;
    }
    const ws = (pkgJson as { workspaces?: unknown }).workspaces;
    if (Array.isArray(ws)) {
      patterns = ws.filter((p): p is string => typeof p === 'string');
    } else if (ws && typeof ws === 'object') {
      const objPkgs = (ws as { packages?: unknown }).packages;
      if (Array.isArray(objPkgs)) {
        patterns = objPkgs.filter((p): p is string => typeof p === 'string');
      }
    }
  }

  if (!patterns || patterns.length === 0) return null;

  // Path normalization (Windows-edited yaml may use backslashes).
  patterns = patterns.map((p) => p.replace(/\\/g, '/'));

  // Pre-expansion safety filter (Codex review §3).
  const { safe } = applyGlobSafetyFilter(patterns, 'js');
  if (safe.length === 0) return null;

  const matches = globSync(safe, {
    cwd: resolvedRoot,
    absolute: true,
    onlyFiles: false,
    ignore: WORKSPACE_GLOB_IGNORES,
  });
  if (matches.length === 0) {
    log.info('js_workspace_glob_no_matches', { patterns: safe });
    return pnpmYamlPath ? { members: [], deps: [], pnpmWorkspaceYamlPath: pnpmYamlPath } : null;
  }

  // Map absolute → relative member dirs, dedup.
  const seen = new Set<string>();
  const memberDirs: string[] = [];
  for (const abs of matches) {
    if (!abs.startsWith(resolvedRoot + sep)) continue;
    const rel = path.relative(resolvedRoot, abs);
    if (rel.length === 0 || seen.has(rel)) continue;
    seen.add(rel);
    memberDirs.push(rel);
  }

  // Truncate at MAX_WORKSPACE_MEMBERS.
  let candidates = memberDirs;
  if (candidates.length > MAX_WORKSPACE_MEMBERS) {
    log.warn('js_workspace_members_truncated', {
      total: candidates.length,
      kept: MAX_WORKSPACE_MEMBERS,
      dropped: candidates.length - MAX_WORKSPACE_MEMBERS,
    });
    candidates = candidates.slice(0, MAX_WORKSPACE_MEMBERS);
  }

  const acceptedMembers: string[] = [];
  const memberDeps: Dependency[] = [];
  for (const m of candidates) {
    const memberDir = path.resolve(resolvedRoot, m);
    // Stage 1: lexical prefix check.
    if (!memberDir.startsWith(resolvedRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `JS workspace member ${m} escapes project root`,
        m,
      );
    }
    const memberManifest = path.join(memberDir, 'package.json');
    if (!fs.existsSync(memberManifest)) {
      // Glob match expanded to a dir without package.json — skip silently
      // (common when patterns are loose, e.g. `packages/*` with non-package dirs).
      continue;
    }
    // Stage 2: realpath check.
    const realMember = fs.realpathSync(memberDir);
    if (!realMember.startsWith(realRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `JS workspace member ${m} symlink target escapes project root`,
        m,
      );
    }
    const source = readManifestSafely('package.json', memberManifest);
    const parsed = parsePackageJson(source, opts);
    acceptedMembers.push(m);
    for (const d of parsed) memberDeps.push(d);
  }

  return { members: acceptedMembers, deps: memberDeps, pnpmWorkspaceYamlPath: pnpmYamlPath };
}

function mergeJsWorkspace(
  projectRoot: string,
  rootDeps: Dependency[],
  ws: { members: string[]; deps: Dependency[]; pnpmWorkspaceYamlPath?: string },
): ProjectScan {
  // Dedup by (name, ecosystem) — first wins.
  const seen = new Set<string>();
  const merged: Dependency[] = [];
  for (const d of [...rootDeps, ...ws.deps]) {
    const key = `${d.name}\x00${d.ecosystem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
  }
  const result: ProjectScan = {
    projectRoot,
    manifestType: 'package.json',
    dependencies: merged,
    workspaceMembers: ws.members,
  };
  if (ws.pnpmWorkspaceYamlPath) {
    result.extraManifestFiles = [ws.pnpmWorkspaceYamlPath];
  }
  return result;
}

/**
 * v2.4: aggregator-pom traversal. Walks each `<module>` directory under the
 * aggregator's projectRoot, parses `<dir>/pom.xml` via `parsePomXml`, and
 * returns the merged dep list + accepted member dirs. Reuses the same
 * two-stage path safety (lexical prefix + realpath) as the Cargo workspace
 * path so `<module>../../etc</module>` cannot escape projectRoot.
 *
 * Missing module dirs are warn-logged and skipped (not thrown). Truncate-
 * with-warn at MAX_WORKSPACE_MEMBERS preserves bounded scan work.
 */
function traverseAggregatorPom(
  projectRoot: string,
  moduleDirs: string[],
  opts: ScanOpts,
): WorkspaceResult {
  const log = getLogger();
  const resolvedRoot = path.resolve(projectRoot);
  const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
  const sep = path.sep;

  let candidates = moduleDirs;
  if (candidates.length > MAX_WORKSPACE_MEMBERS) {
    log.warn('pom_aggregator_modules_truncated', {
      total: candidates.length,
      kept: MAX_WORKSPACE_MEMBERS,
      dropped: candidates.length - MAX_WORKSPACE_MEMBERS,
    });
    candidates = candidates.slice(0, MAX_WORKSPACE_MEMBERS);
  }

  const acceptedMembers: string[] = [];
  const memberDeps: Dependency[] = [];

  for (const m of candidates) {
    const joined = path.resolve(resolvedRoot, m, 'pom.xml');
    if (!joined.startsWith(resolvedRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `aggregator module ${m} escapes project root before symlink resolution`,
        m,
      );
    }
    if (!fs.existsSync(joined)) {
      log.warn('pom_aggregator_module_missing', { module: m });
      continue;
    }
    const real = fs.realpathSync(joined);
    if (!real.startsWith(realRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `aggregator module ${m} symlink target escapes project root`,
        m,
      );
    }
    const memberSource = readManifestSafely('pom.xml', joined);
    const memberDeps2 = parsePomXml(memberSource, opts);
    acceptedMembers.push(m);
    for (const d of memberDeps2) memberDeps.push(d);
  }

  return { members: acceptedMembers, deps: memberDeps };
}

/**
 * v2.4: merge aggregator + module deps with first-wins dedup keyed on
 * `(name, kind)`. Aggregator's own deps appear FIRST so they take precedence
 * over module deps that share the same coordinate (rare but valid Maven).
 */
function mergeAggregatorPom(
  projectRoot: string,
  rootDeps: Dependency[],
  ws: WorkspaceResult,
): ProjectScan {
  const seen = new Set<string>();
  const merged: Dependency[] = [];
  for (const d of [...rootDeps, ...ws.deps]) {
    const key = `${d.name}\x00${d.kind ?? 'runtime'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
  }
  return {
    projectRoot,
    manifestType: 'pom.xml',
    dependencies: merged,
    workspaceMembers: ws.members,
  };
}

/**
 * v2.5 (was v2.4 `discoverGradleSubprojects`): discover Gradle subprojects
 * from `settings.gradle(.kts)` AND parse each subproject's
 * `build.gradle(.kts)` AND the root `build.gradle(.kts)`. Aggregate root +
 * catalog `rootDeps` + per-subproject deps deduped first-wins by
 * `(name, ecosystem, kind)`. Order: root build.gradle → catalog → subprojects
 * in declaration order.
 *
 * Returns null when neither settings.gradle(.kts) NOR root build.gradle(.kts)
 * is present (back-compat with v2.3/v2.4 behavior — fall through to
 * catalog-only ProjectScan in the caller).
 */
function discoverGradleProjects(
  projectRoot: string,
  rootDeps: Dependency[],
  opts: ScanOpts,
): ProjectScan | null {
  const log = getLogger();
  const sep = path.sep;
  const resolvedRoot = path.resolve(projectRoot);

  // Locate settings.gradle(.kts).
  let settingsPath: string | null = null;
  for (const c of ['settings.gradle.kts', 'settings.gradle']) {
    const abs = path.resolve(projectRoot, c);
    if (fs.existsSync(abs)) {
      settingsPath = abs;
      break;
    }
  }

  // Locate root build.gradle(.kts).
  let rootBuildPath: string | null = null;
  for (const c of ['build.gradle.kts', 'build.gradle']) {
    const abs = path.resolve(projectRoot, c);
    if (fs.existsSync(abs)) {
      rootBuildPath = abs;
      break;
    }
  }

  if (settingsPath === null && rootBuildPath === null) return null;

  // Discover subprojects (only when settings.gradle exists).
  const acceptedSubprojects: string[] = [];
  if (settingsPath !== null) {
    const settingsSource = readManifestSafely('settings.gradle', settingsPath);
    const subprojects = parseSettingsGradle(settingsSource);
    for (const sub of subprojects) {
      const abs = path.resolve(resolvedRoot, sub);
      if (!abs.startsWith(resolvedRoot + sep)) {
        log.warn('gradle_subproject_escape', { subproject: sub });
        continue;
      }
      if (!fs.existsSync(abs)) {
        log.warn('gradle_subproject_missing', { subproject: sub });
        continue;
      }
      acceptedSubprojects.push(sub);
    }
  }

  // Helper: locate a build.gradle(.kts) inside a directory; returns null if absent.
  const findBuildGradle = (subDir: string): string | null => {
    for (const c of ['build.gradle.kts', 'build.gradle']) {
      const abs = path.resolve(subDir, c);
      if (fs.existsSync(abs)) return abs;
    }
    return null;
  };

  // Per-subproject build.gradle paths (for parsing AND extraManifestFiles).
  const subprojectBuildPaths: string[] = [];
  for (const sub of acceptedSubprojects) {
    const subDir = path.resolve(resolvedRoot, sub);
    const buildPath = findBuildGradle(subDir);
    if (buildPath !== null) subprojectBuildPaths.push(buildPath);
  }

  // Aggregate deps: root build.gradle → catalog → subprojects in order.
  // First-wins dedup keyed (name, ecosystem, kind).
  const seen = new Set<string>();
  const aggregated: Dependency[] = [];
  const pushUnique = (d: Dependency): void => {
    const k = `${d.name}|${d.ecosystem}|${d.kind ?? 'runtime'}`;
    if (seen.has(k)) return;
    seen.add(k);
    aggregated.push(d);
  };

  // v2.5: warn-once-per-id for unmapped plugins (across all parsed build files).
  const warnedUnmappedPlugins = new Set<string>();
  const collectPluginsFrom = (source: string): Dependency[] => {
    const out: Dependency[] = [];
    for (const p of extractPluginIds(source)) {
      const coord = resolveGradlePluginCoord(p.id);
      if (!coord) {
        if (!warnedUnmappedPlugins.has(p.id)) {
          warnedUnmappedPlugins.add(p.id);
          log.warn('gradle_plugin_unmapped', { pluginId: p.id });
        }
        continue;
      }
      out.push({
        name: `${coord.groupId}:${coord.artifactId}`,
        ecosystem: 'maven',
        declaredVersion: p.version,
        kind: 'runtime',
      });
    }
    return out;
  };

  if (rootBuildPath !== null) {
    const rootSource = readManifestSafely('package.json', rootBuildPath);
    for (const d of parseBuildGradle(rootSource, { includeDev: opts.includeDev })) {
      pushUnique(d);
    }
    for (const d of collectPluginsFrom(rootSource)) pushUnique(d);
  }
  for (const d of rootDeps) pushUnique(d);
  for (const buildPath of subprojectBuildPaths) {
    const subSource = readManifestSafely('package.json', buildPath);
    for (const d of parseBuildGradle(subSource, { includeDev: opts.includeDev })) {
      pushUnique(d);
    }
    for (const d of collectPluginsFrom(subSource)) pushUnique(d);
  }

  const result: ProjectScan = {
    projectRoot,
    manifestType: 'libs.versions.toml',
    dependencies: aggregated,
  };
  if (acceptedSubprojects.length > 0) result.workspaceMembers = acceptedSubprojects;

  const extras: string[] = [];
  if (settingsPath !== null) extras.push(settingsPath);
  if (rootBuildPath !== null) extras.push(rootBuildPath);
  for (const p of subprojectBuildPaths) extras.push(p);
  if (extras.length > 0) result.extraManifestFiles = extras;

  return result;
}

/**
 * v2.4: go.work workspace traversal. Parses the go.work file, walks each
 * `use` directory, parses the member `go.mod` via the existing `parseGoMod`,
 * aggregates + dedups by `(name, ecosystem)` first-wins. The go.work itself
 * has no direct deps. Surfaces `use` dirs through `workspaceMembers` so the
 * watcher can derive `<dir>/go.mod` per member.
 */
function handleGoWorkMatch(
  projectRoot: string,
  goWorkPath: string,
  opts: ScanOpts,
): ProjectScan {
  const log = getLogger();
  const source = readManifestSafely('go.work', goWorkPath);
  const useDirs = parseGoWork(source);

  const resolvedRoot = path.resolve(projectRoot);
  const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
  const sep = path.sep;

  let candidates = useDirs;
  if (candidates.length > MAX_WORKSPACE_MEMBERS) {
    log.warn('go_work_use_dirs_truncated', {
      total: candidates.length,
      kept: MAX_WORKSPACE_MEMBERS,
      dropped: candidates.length - MAX_WORKSPACE_MEMBERS,
    });
    candidates = candidates.slice(0, MAX_WORKSPACE_MEMBERS);
  }

  const acceptedMembers: string[] = [];
  const seen = new Set<string>();
  const merged: Dependency[] = [];

  for (const m of candidates) {
    const memberDir = path.resolve(resolvedRoot, m);
    if (!memberDir.startsWith(resolvedRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `go.work use ${m} escapes project root before symlink resolution`,
        m,
      );
    }
    const memberManifest = path.join(memberDir, 'go.mod');
    if (!fs.existsSync(memberManifest)) {
      log.warn('go_work_member_missing', { member: m });
      continue;
    }
    const real = fs.realpathSync(memberManifest);
    if (!real.startsWith(realRoot + sep)) {
      throw new ManifestError(
        'unsafe_manifest',
        `go.work use ${m} symlink target escapes project root`,
        m,
      );
    }
    const memberSource = readManifestSafely('go.mod', memberManifest);
    const memberDeps = parseGoMod(memberSource, opts);
    for (const d of memberDeps) {
      const key = `${d.name}\x00${d.ecosystem}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(d);
    }
    acceptedMembers.push(m);
  }

  merged.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const result: ProjectScan = {
    projectRoot,
    manifestType: 'go.work',
    dependencies: merged,
    matchedManifestPath: goWorkPath,
  };
  if (acceptedMembers.length > 0) result.workspaceMembers = acceptedMembers;
  return result;
}

function mergeWorkspace(
  projectRoot: string,
  manifestType: ManifestType,
  rootDeps: Dependency[],
  ws: WorkspaceResult,
): ProjectScan {
  // De-dup by (name, kind) — first wins, matching the v1 ordering rule.
  const seen = new Set<string>();
  const merged: Dependency[] = [];
  for (const d of [...rootDeps, ...ws.deps]) {
    const key = `${d.name}\x00${d.kind ?? 'runtime'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
  }
  return {
    projectRoot,
    manifestType,
    dependencies: merged,
    workspaceMembers: ws.members,
  };
}
