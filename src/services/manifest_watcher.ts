/**
 * Manifest watcher (v2.2). chokidar-backed file watch on the project's
 * captured manifestPath (and its Cargo workspace members, if any). On change,
 * re-parses the EXACT manifestPath via `rescanManifest` (no upward walk),
 * diffs the dep set keyed by `(name, ecosystem)`, and invalidates cached
 * resolutions for removed deps.
 *
 * Intentionally NOT wired into the MCP server — `manifest_watcher.ts` is
 * a side-effect-only cache hook that runs alongside the server in `index.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';

import { rescanFromRoot, ScanOpts } from './project_scanner.js';
import { Cache } from './cache.js';
import { Dependency, ManifestType, ProjectScan } from '../types.js';
import { getLogger, Logger } from '../logging.js';
import { MAX_WATCHED_PATHS } from '../config.js';

/**
 * v0.6: additive root for polyglot-monorepo subdir scans. Each entry is a
 * fully-formed root sibling to the primary (`projectRoot` + `manifestPath`
 * + optional members/extras + the initial `ProjectScan`). When empty / absent,
 * `ManifestWatcher` behavior is bit-equal with v2.4 single-root mode.
 */
export interface AdditionalRoot {
  projectRoot: string;
  manifestPath: string;
  workspaceMembers?: string[];
  extraManifestFiles?: string[];
  initialScan: ProjectScan;
}

export interface ManifestWatcherOpts {
  projectRoot: string;
  manifestPath: string;
  /**
   * v2.2/v2.3: workspace MEMBER DIRECTORIES (Cargo or JS). The watcher derives
   * the per-ecosystem manifest filename via `deriveMemberManifest`.
   */
  workspaceMembers?: string[];
  /**
   * v2.3: additional FULL FILE PATHS the watcher must observe verbatim — e.g.
   * `Directory.Packages.props` (CPM upward walk), `pnpm-workspace.yaml`,
   * extra `*.csproj` matches in the same dir. NEVER carries member dirs.
   */
  extraManifestFiles?: string[];
  cache: Cache;
  scannerOpts: ScanOpts;
  initialScan: ProjectScan;
  log?: Logger;
  /**
   * v0.6: additional root manifests discovered by `scanProjectRecursive`.
   * Empty / undefined → primary-only behavior (back-compat).
   */
  additionalRoots?: AdditionalRoot[];
}

interface RootEntry {
  projectRoot: string;
  manifestPath: string;
  workspaceMembers?: string[];
  extraManifestFiles?: string[];
  previousScan: ProjectScan;
}

/**
 * v2.3: derive the per-ecosystem member-manifest filename for a workspace
 * member dir. Cargo workspaces → `<dir>/Cargo.toml`; JS workspaces (npm/yarn/
 * pnpm) → `<dir>/package.json`. Returns null for ecosystems without a known
 * member-manifest mapping (defensive — caller logs warn and skips).
 */
function deriveMemberManifest(
  projectRoot: string,
  memberDir: string,
  manifestType: ManifestType | null,
): string | null {
  switch (manifestType) {
    case 'Cargo.toml':
      return path.resolve(projectRoot, memberDir, 'Cargo.toml');
    case 'package.json':
      return path.resolve(projectRoot, memberDir, 'package.json');
    case 'pom.xml':
      return path.resolve(projectRoot, memberDir, 'pom.xml');
    case 'go.work':
      return path.resolve(projectRoot, memberDir, 'go.mod');
    case 'libs.versions.toml': {
      // v2.5: Gradle subproject build files. Prefer .kts when present;
      // fall back to Groovy. NULL when neither exists (the subproject is
      // discovery-only — surfaced via workspaceMembers but no per-member
      // manifest to watch). NOT a `DISCOVERY_ONLY_TYPES` member anymore —
      // the per-member parsing in v2.5 means edits to subproject build
      // files SHOULD trigger a rescan.
      const kts = path.resolve(projectRoot, memberDir, 'build.gradle.kts');
      if (fs.existsSync(kts)) return kts;
      const groovy = path.resolve(projectRoot, memberDir, 'build.gradle');
      if (fs.existsSync(groovy)) return groovy;
      return null;
    }
    default:
      return null;
  }
}

/**
 * v2.4: manifest types whose `workspaceMembers` are surfaced for diagnostics
 * but have no per-member manifest the watcher can derive. Returning `null`
 * from `deriveMemberManifest` for these types is intentional —
 * `computeWatchSet` suppresses the `manifest_watcher_member_unknown_ecosystem`
 * warn for them.
 *
 * v2.5: `libs.versions.toml` is REMOVED from this set — per-subproject
 * build.gradle(.kts) parsing means edits should trigger a rescan when the
 * file exists. Subprojects without a build.gradle(.kts) still return null
 * from `deriveMemberManifest` but the discovery-only suppression is no
 * longer blanket-applied.
 */
const DISCOVERY_ONLY_TYPES: ReadonlySet<ManifestType> = new Set<ManifestType>([]);

export class ManifestWatcher {
  private watcher: FSWatcher | null = null;
  private readonly opts: ManifestWatcherOpts;
  private readonly log: Logger;
  private _degradedMode = false;
  /** Roots[0] = primary (back-compat); roots[1..] = additionalRoots. */
  private readonly roots: RootEntry[];

  constructor(opts: ManifestWatcherOpts) {
    this.opts = opts;
    this.log = opts.log ?? getLogger();
    const primary: RootEntry = {
      projectRoot: opts.projectRoot,
      manifestPath: opts.manifestPath,
      workspaceMembers: opts.workspaceMembers,
      extraManifestFiles: opts.extraManifestFiles,
      previousScan: opts.initialScan,
    };
    const additional: RootEntry[] = (opts.additionalRoots ?? []).map((r) => ({
      projectRoot: r.projectRoot,
      manifestPath: r.manifestPath,
      workspaceMembers: r.workspaceMembers,
      extraManifestFiles: r.extraManifestFiles,
      previousScan: r.initialScan,
    }));
    this.roots = [primary, ...additional];
  }

  /**
   * v2.4: true when `computeWatchSet` had to truncate the watch set at
   * `MAX_WATCHED_PATHS`. Diagnostic only — NOT surfaced through the MCP
   * tool output. Stable for the watcher's lifetime (set once on `start()`).
   */
  get degradedMode(): boolean {
    return this._degradedMode;
  }

  start(): void {
    const watched = this.computeWatchSet();

    this.watcher = chokidar.watch(watched, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 50 },
    });

    const onChange = (changedPath: string): void => {
      try {
        this.handleChange(changedPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('manifest_watcher_handle_error', { err: msg });
      }
    };

    this.watcher.on('change', onChange);
    this.watcher.on('add', onChange);
    this.watcher.on('unlink', onChange);
    this.watcher.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn('manifest_watcher_error', { err: msg });
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Exposed for testing — triggers the same path as a real change event.
   *
   * v2.3 (Codex H1 + Claude must_fix): re-runs `rescanFromRoot(projectRoot)`
   * instead of the v2.2 `rescanManifest(manifestPath)` basename-lookup path.
   * This ensures changes to ANY watched file (canonical manifest, csproj,
   * gradle catalog, Directory.Packages.props, pnpm-workspace.yaml, JS
   * workspace member package.json, Cargo glob-expanded member Cargo.toml)
   * trigger the full v2.3 dispatch — multi-csproj+CPM, JS workspace
   * traversal, etc. — and produce an accurate dep-set diff.
   */
  handleChange(changedPath?: string): void {
    // v0.6: route the rescan to the OWNING root. Default to primary when no
    // path is supplied (back-compat for tests that drive handleChange()
    // directly without a path argument). When a path IS supplied but no root
    // claims it, log + return rather than silently rescanning primary — a
    // spurious primary rescan can wrongly invalidate caches that the stray
    // event was never about.
    let owner: RootEntry;
    if (changedPath) {
      const found = this.findOwningRoot(changedPath);
      if (!found) {
        this.log.warn('manifest_watcher_unknown_path', { changedPath });
        return;
      }
      owner = found;
    } else {
      owner = this.roots[0];
    }
    const next = rescanFromRoot(owner.projectRoot, this.opts.scannerOpts);
    // v2.3 transient-race guard (preserves v2.2 behavior of `rescanManifest`'s
    // `prev` parameter): if rescanFromRoot returned no manifest while we
    // previously had one, the canonical manifest is mid-rename — keep the
    // previous scan and skip invalidation. Mirror is also true for ENOENT
    // races on workspace members; we keep state until the next valid event.
    if (next.manifestType === null && owner.previousScan.manifestType !== null) {
      this.log.info('manifest_watcher_transient_no_manifest', {
        projectRoot: owner.projectRoot,
      });
      return;
    }
    this.invalidateForRemovals(owner.previousScan.dependencies, next.dependencies);
    this.reconcileWatchSet(
      owner,
      owner.previousScan.workspaceMembers,
      next.workspaceMembers,
      owner.previousScan.extraManifestFiles,
      next.extraManifestFiles,
    );
    owner.previousScan = next;
    owner.workspaceMembers = next.workspaceMembers;
    owner.extraManifestFiles = next.extraManifestFiles;
  }

  /**
   * v0.6: map a chokidar-emitted path to its owning root. Primary's manifest
   * + extras + member-derived paths → primary; same for each additional root.
   * Returns null when no root claims the path; caller logs + returns without
   * rescanning (silent fallback to primary would spuriously invalidate
   * unrelated caches).
   */
  private findOwningRoot(changedPath: string): RootEntry | null {
    const resolved = path.resolve(changedPath);
    for (const root of this.roots) {
      if (path.resolve(root.manifestPath) === resolved) return root;
      for (const e of root.extraManifestFiles ?? []) {
        if (path.resolve(e) === resolved) return root;
      }
      const manifestType = root.previousScan.manifestType;
      for (const m of root.workspaceMembers ?? []) {
        const derived = deriveMemberManifest(root.projectRoot, m, manifestType);
        if (derived && path.resolve(derived) === resolved) return root;
      }
    }
    return null;
  }

  /**
   * v0.6: compute the union of (manifestPath + extras + members) for ALL
   * roots, dedup, and truncate-with-priority at MAX_WATCHED_PATHS.
   *
   * Root-first truncate priority (per plan + Claude review fix):
   *   1. ALL root manifestPaths (primary first, then each additional root in
   *      BFS order) — a polyglot ecosystem root outranks the 257th workspace
   *      member of the primary.
   *   2. ALL extraManifestFiles (concatenated, primary first).
   *   3. ALL workspace-derived member manifests (concatenated, primary first).
   */
  private computeWatchSet(): string[] {
    const rootManifestPaths: string[] = [];
    const allExtras: string[] = [];
    const allMembers: string[] = [];
    for (const root of this.roots) {
      rootManifestPaths.push(root.manifestPath);
      if (root.extraManifestFiles) allExtras.push(...root.extraManifestFiles);
      const manifestType = root.previousScan.manifestType;
      for (const m of root.workspaceMembers ?? []) {
        const derived = deriveMemberManifest(root.projectRoot, m, manifestType);
        if (derived !== null) {
          allMembers.push(derived);
        } else if (manifestType === null || !DISCOVERY_ONLY_TYPES.has(manifestType)) {
          this.log.warn('manifest_watcher_member_unknown_ecosystem', { manifestType, member: m });
        }
      }
    }
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const p of [...rootManifestPaths, ...allExtras, ...allMembers]) {
      if (!seen.has(p)) {
        seen.add(p);
        ordered.push(p);
      }
    }
    if (ordered.length > MAX_WATCHED_PATHS) {
      this.log.warn('manifest_watcher_truncated', {
        total: ordered.length,
        kept: MAX_WATCHED_PATHS,
        dropped: ordered.length - MAX_WATCHED_PATHS,
      });
      this._degradedMode = true;
      return ordered.slice(0, MAX_WATCHED_PATHS);
    }
    this._degradedMode = false;
    return ordered;
  }

  /**
   * Codex review H1 fix: keep the chokidar watch set in sync with the current
   * workspace member list. Without this, a member added after startup is in
   * `previousScan` but never watched, so subsequent dep removals from that
   * member never fire a change event and caches go stale.
   *
   * v2.3 generalization: derives the per-ecosystem manifest filename via
   * `deriveMemberManifest` so JS workspaces work the same as Cargo.
   *
   * v2.4 (Codex M3 fix): also reconciles `extraManifestFiles` so a sln edit
   * that adds a new csproj path (or a settings.gradle edit that adds a new
   * subproject) gets picked up by chokidar. Without this, the new aux file
   * stays unwatched and later edits to it don't trigger rescans.
   */
  private reconcileWatchSet(
    owner: RootEntry,
    prevMembers: string[] | undefined,
    nextMembers: string[] | undefined,
    prevExtras: string[] | undefined,
    nextExtras: string[] | undefined,
  ): void {
    if (!this.watcher) return;
    const root = owner.projectRoot;
    const manifestType = owner.previousScan.manifestType;
    const toPath = (m: string): string | null => deriveMemberManifest(root, m, manifestType);
    const prevMemberSet = new Set(
      (prevMembers ?? []).map(toPath).filter((p): p is string => p !== null),
    );
    const nextMemberSet = new Set(
      (nextMembers ?? []).map(toPath).filter((p): p is string => p !== null),
    );
    const prevExtraSet = new Set(prevExtras ?? []);
    const nextExtraSet = new Set(nextExtras ?? []);

    const added: string[] = [];
    const removed: string[] = [];
    for (const p of nextMemberSet) if (!prevMemberSet.has(p)) added.push(p);
    for (const p of nextExtraSet) if (!prevExtraSet.has(p)) added.push(p);
    for (const p of prevMemberSet) if (!nextMemberSet.has(p)) removed.push(p);
    for (const p of prevExtraSet) if (!nextExtraSet.has(p)) removed.push(p);

    if (added.length > 0) this.watcher.add(added);
    if (removed.length > 0) this.watcher.unwatch(removed);
    if (added.length > 0 || removed.length > 0) {
      this.log.info('manifest_watcher_reconciled', { added: added.length, removed: removed.length });
    }
  }

  private invalidateForRemovals(prev: Dependency[], next: Dependency[]): void {
    // Diff by (name, ecosystem) ONLY — not kind. A runtime↔dev kind-flip on the
    // same name MUST NOT invalidate cache.repos.
    const nextKeys = new Set(next.map((d) => `${d.name}\x00${d.ecosystem}`));
    const removed = prev.filter((d) => !nextKeys.has(`${d.name}\x00${d.ecosystem}`));
    if (removed.length === 0) return;

    // For each removed dep: invalidate cache.repos. Then check if any surviving
    // dep still resolves to the same <owner>/<repo>; if not, invalidate wiki_status.
    for (const d of removed) {
      const cached = this.opts.cache.getRepo(d.name, d.ecosystem);
      this.opts.cache.invalidateRepo(d.name, d.ecosystem);
      if (cached) {
        const repo = `${cached.owner}/${cached.repo}`;
        const surviving = next.some((s) => {
          const sCached = this.opts.cache.getRepo(s.name, s.ecosystem);
          return sCached && `${sCached.owner}/${sCached.repo}` === repo;
        });
        if (!surviving) {
          this.opts.cache.invalidateWikiStatus(repo);
        }
      }
    }
    this.log.info('manifest_watcher_invalidated', {
      removed: removed.map((d) => `${d.name}@${d.ecosystem}`),
    });
  }
}
