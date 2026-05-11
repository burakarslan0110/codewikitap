/**
 * v2.5 Maven `<parent>` POM resolver — async post-scan enrichment.
 *
 * Architecture invariant: the parser stays pure (`src/adapters/manifests/`
 * has no network primitives). Parent POM resolution lives here in the
 * service layer where async I/O is allowed. Mirrors v2.4's `bom_resolver.ts`.
 *
 * Behavior:
 *   - Fetches the parent POM listed in `scan.parentCoords` from Maven Central
 *     (`https://repo1.maven.org/maven2/<groupPath>/<artifactId>/<version>/<artifactId>-<version>.pom`).
 *   - Caches parsed `<dependencyManagement>` literal version map in
 *     `cache.maven_parent_versions`.
 *   - Single-flight collapses concurrent identical fetches.
 *   - Patches every `Dependency.declaredVersion === undefined` entry whose
 *     `groupId:artifactId` is in the parent's literal DM map (preserves
 *     child-set versions — child literal DM > parent literal DM).
 *   - **Codex high fix #3:** APPENDS the parent's nested
 *     `<scope>import</scope>` BOMs onto `scan.bomImports` so the recursive
 *     `bom_resolver` walker (running AFTER parent_resolver in the tool
 *     chain) sees them at depth 0 alongside the child's own BOMs. This
 *     enables the dominant Spring Boot Starter Parent pattern: app pom →
 *     <parent>spring-boot-starter-parent</parent>; the parent itself imports
 *     `spring-boot-dependencies` BOM via `<scope>import</scope>`; child deps
 *     inherit versions from the BOM, not from the parent's literal DM
 *     (which is empty).
 *   - Fail-soft: ANY error (network, 404, parse) → warn-log, skip the
 *     parent, continue. NEVER throws to the caller.
 *   - Pure when `parentCoords` is undefined: returns the input scan
 *     reference unchanged (zero-cost fast path; no DB read).
 *
 * One parent level deep — parent's own `<parent>` chain is NOT walked
 * recursively in v2.5 (deferred to v2.6).
 */

import { Cache } from './cache.js';
import { ProjectScan, BomImport, ParentCoords } from '../types.js';
import { getLogger } from '../logging.js';
import { FETCH_TIMEOUT_MS } from '../config.js';
import { parsePomDependencyManagement } from './_pom_dm_parser.js';

interface ParentFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type ParentFetcher = (url: string) => Promise<ParentFetchResponse>;

interface ParentResolution {
  versionMap: Record<string, string>;
  nestedBoms: BomImport[];
}

const inflight = new Map<string, Promise<ParentResolution | null>>();

function parentKey(p: ParentCoords): string {
  return `${p.groupId}:${p.artifactId}:${p.version}`;
}

function parentUrl(p: ParentCoords): string {
  const groupPath = p.groupId.replace(/\./g, '/');
  return `https://repo1.maven.org/maven2/${groupPath}/${p.artifactId}/${p.version}/${p.artifactId}-${p.version}.pom`;
}

async function defaultFetch(url: string): Promise<ParentFetchResponse> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } finally {
    clearTimeout(t);
  }
}

async function loadParentResolution(
  parent: ParentCoords,
  cache: Cache,
  fetcher: ParentFetcher,
): Promise<ParentResolution | null> {
  // v2.5 post-verify Codex high fix: cached row now carries BOTH literal
  // DM versions AND nested BOM imports. Previously this returned
  // `nestedBoms: []` on cache hit, which broke the Spring Boot Starter
  // Parent canonical pattern on the warm-cache path (parent's nested
  // spring-boot-dependencies BOM was no longer appended to scan.bomImports
  // after the first cold call, so dependencies inheriting from that BOM
  // stayed `declaredVersion: undefined`).
  const cached = cache.getMavenParentVersions(parent.groupId, parent.artifactId, parent.version);
  if (cached) {
    return { versionMap: cached.versionMap, nestedBoms: cached.nestedBoms };
  }

  const key = parentKey(parent);
  const existing = inflight.get(key);
  if (existing) return existing;

  const log = getLogger();
  const promise = (async (): Promise<ParentResolution | null> => {
    try {
      const url = parentUrl(parent);
      const res = await fetcher(url);
      if (!res.ok) {
        log.warn('parent_resolver_fetch_failed', { parent: key, status: res.status });
        return null;
      }
      const text = await res.text();
      const parsed = parsePomDependencyManagement(text);
      // Persist BOTH versions AND nestedBoms so warm-cache hits replay the
      // BOM-import flow identically.
      cache.setMavenParentVersions(
        parent.groupId,
        parent.artifactId,
        parent.version,
        parsed.versions,
        parsed.nestedBoms,
      );
      return { versionMap: parsed.versions, nestedBoms: parsed.nestedBoms };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('parent_resolver_error', { parent: key, reason });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/**
 * Patch `scan.dependencies[].declaredVersion` from the parent POM's literal
 * `<dependencyManagement>` (preserves child-set versions). APPENDS the
 * parent's nested `<scope>import</scope>` BOMs onto `scan.bomImports` so the
 * recursive `bom_resolver` walker resolves them at depth 0. Returns a NEW
 * `ProjectScan` when changes are applied; returns the input reference
 * unchanged when no parent is declared (fast path).
 */
export async function enrichWithParentPom(
  scan: ProjectScan,
  cache: Cache,
  fetcher: ParentFetcher = defaultFetch,
): Promise<ProjectScan> {
  const parent = scan.parentCoords;
  if (!parent) return scan;

  const resolution = await loadParentResolution(parent, cache, fetcher);
  if (!resolution) return scan;

  const { versionMap, nestedBoms } = resolution;

  let depsTouched = false;
  const patchedDeps =
    Object.keys(versionMap).length === 0
      ? scan.dependencies
      : scan.dependencies.map((d) => {
          if (d.ecosystem !== 'maven') return d;
          if (d.declaredVersion !== undefined) return d;
          const v = versionMap[d.name];
          if (v === undefined) return d;
          depsTouched = true;
          return { ...d, declaredVersion: v };
        });

  const bomsTouched = nestedBoms.length > 0;
  const mergedBoms = bomsTouched ? [...(scan.bomImports ?? []), ...nestedBoms] : scan.bomImports;

  if (!depsTouched && !bomsTouched) return scan;

  return {
    ...scan,
    dependencies: patchedDeps,
    ...(bomsTouched ? { bomImports: mergedBoms } : {}),
  };
}
