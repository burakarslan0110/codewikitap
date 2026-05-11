/**
 * v2.4 Maven BOM resolver — async post-scan enrichment.
 *
 * Architecture invariant: the parser stays pure (`src/adapters/manifests/`
 * has no network primitives — enforced by ESLint + parser_purity test).
 * BOM resolution lives here in the service layer where async I/O is allowed.
 *
 * Behavior:
 *   - Fetches each BOM POM listed in `scan.bomImports` from Maven Central
 *     (`https://repo1.maven.org/maven2/<groupPath>/<artifactId>/<version>/<artifactId>-<version>.pom`).
 *   - Caches parsed `<dependencyManagement>` version maps in
 *     `cache.maven_bom_versions` (forever; BOMs at fixed versions are immutable).
 *   - Single-flight collapses concurrent identical fetches.
 *   - Merges all BOM maps (last-wins on collision; matches Maven's documented
 *     `<dependencyManagement>` order semantics).
 *   - Patches every `Dependency.declaredVersion === undefined` entry whose
 *     `name` (`groupId:artifactId`) is in the merged map.
 *   - Fail-soft: ANY error (network, 404, parse) → warn-log, skip the BOM,
 *     continue. NEVER throws to the caller.
 *   - Pure when `bomImports` is empty/undefined: returns the input scan
 *     reference unchanged (zero-cost fast path; no DB read).
 */

import { Cache } from './cache.js';
import { ProjectScan, BomImport } from '../types.js';
import { getLogger } from '../logging.js';
import { FETCH_TIMEOUT_MS, MAX_BOM_DEPTH } from '../config.js';
import { parsePomDependencyManagement } from './_pom_dm_parser.js';

interface BomFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type BomFetcher = (url: string) => Promise<BomFetchResponse>;

interface BomResolution {
  versions: Record<string, string>;
  nestedBoms: BomImport[];
}

const inflight = new Map<string, Promise<BomResolution | null>>();

function bomKey(b: BomImport): string {
  return `${b.groupId}:${b.artifactId}:${b.version}`;
}

function bomUrl(b: BomImport): string {
  const groupPath = b.groupId.replace(/\./g, '/');
  return `https://repo1.maven.org/maven2/${groupPath}/${b.artifactId}/${b.version}/${b.artifactId}-${b.version}.pom`;
}

async function defaultFetch(url: string): Promise<BomFetchResponse> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Load a single BOM's `{ versions, nestedBoms }` resolution. Cache hit
 * returns persisted versions only — nested BOMs are NOT cached because
 * (a) walking them is the recursive walker's job and (b) every nested BOM
 * itself goes through `loadBomResolution` which has its own cache, so the
 * net work is the same: the only "lost" cache hit is the in-call BFS edge,
 * not any actual fetch.
 */
async function loadBomResolution(
  bom: BomImport,
  cache: Cache,
  fetcher: BomFetcher,
): Promise<BomResolution | null> {
  // v2.5 post-verify Codex high fix: cached row carries BOTH versions AND
  // nestedBoms (envelope shape). Returning nestedBoms from cache is what
  // restores correctness on warm-cache hits — previously the walker dropped
  // depth-N+1 frontier when the depth-N BOM was already cached.
  const cached = cache.getMavenBomVersions(bom.groupId, bom.artifactId, bom.version);
  if (cached) return { versions: cached.versionMap, nestedBoms: cached.nestedBoms };

  const key = bomKey(bom);
  const existing = inflight.get(key);
  if (existing) return existing;

  const log = getLogger();
  const promise = (async (): Promise<BomResolution | null> => {
    try {
      const url = bomUrl(bom);
      const res = await fetcher(url);
      if (!res.ok) {
        log.warn('bom_resolver_fetch_failed', { bom: key, status: res.status });
        return null;
      }
      const text = await res.text();
      const parsed = parsePomDependencyManagement(text);
      // Persist BOTH versions AND nestedBoms so warm-cache hits replay the
      // recursive walk identically.
      cache.setMavenBomVersions(
        bom.groupId,
        bom.artifactId,
        bom.version,
        parsed.versions,
        parsed.nestedBoms,
      );
      return parsed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('bom_resolver_error', { bom: key, reason });
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/**
 * Patch `scan.dependencies[].declaredVersion` for entries currently
 * undefined whose `groupId:artifactId` appears in the merged BOM version
 * maps. Returns a NEW ProjectScan when patches are applied; returns the
 * input reference unchanged when no BOMs are listed (fast path).
 *
 * v2.5: walks BOM imports recursively (BFS by depth, bounded by
 * `MAX_BOM_DEPTH = 5`). Per-call visited Set keyed `<groupId>:<artifactId>:<version>`
 * — hitting a previously-visited BOM emits a warn-log and skips. Past the
 * depth cap, a single warn-log emits and further enqueueing stops.
 *
 * Precedence: depth-0 wins over depth-1 wins over depth-2 (first-wins
 * across depths). Within a single depth, sibling BOMs merge last-wins
 * (matches Maven's documented `<dependencyManagement>` declaration order).
 */
export async function enrichWithBomImports(
  scan: ProjectScan,
  cache: Cache,
  fetcher: BomFetcher = defaultFetch,
): Promise<ProjectScan> {
  const seedBoms = scan.bomImports;
  if (!seedBoms || seedBoms.length === 0) return scan;

  const log = getLogger();
  const visited = new Set<string>();
  const merged: Record<string, string> = {};

  // Seed depth 0. Skip duplicates within the seed list (defensive).
  let frontier: BomImport[] = [];
  for (const b of seedBoms) {
    const k = bomKey(b);
    if (visited.has(k)) continue;
    visited.add(k);
    frontier.push(b);
  }

  let depthCapWarned = false;

  for (let depth = 0; depth <= MAX_BOM_DEPTH && frontier.length > 0; depth++) {
    // Fetch the entire frontier in parallel.
    const resolutions = await Promise.all(
      frontier.map((b) => loadBomResolution(b, cache, fetcher)),
    );

    // Within-depth merge: last-wins among siblings (matches Maven's
    // <dependencyManagement> declaration order).
    const depthMap: Record<string, string> = {};
    const nextFrontier: BomImport[] = [];
    for (let i = 0; i < resolutions.length; i++) {
      const r = resolutions[i];
      if (!r) continue;
      for (const [k, v] of Object.entries(r.versions)) depthMap[k] = v;
      // Enqueue nested BOMs for the next depth, skipping cycles.
      for (const nb of r.nestedBoms) {
        const nk = bomKey(nb);
        if (visited.has(nk)) {
          log.warn('bom_resolver_cycle_detected', { bom: nk, depth: depth + 1 });
          continue;
        }
        visited.add(nk);
        nextFrontier.push(nb);
      }
    }

    // Cross-depth merge: first-wins (depth-N values fill keys missing from
    // depth < N). Earlier-depth values are NOT overwritten.
    for (const [k, v] of Object.entries(depthMap)) {
      if (merged[k] === undefined) merged[k] = v;
    }

    // Depth-cap: if we'd enqueue past MAX_BOM_DEPTH, emit one warn and stop.
    if (nextFrontier.length > 0 && depth + 1 > MAX_BOM_DEPTH) {
      if (!depthCapWarned) {
        log.warn('bom_resolver_max_depth_reached', {
          maxDepth: MAX_BOM_DEPTH,
          droppedCount: nextFrontier.length,
        });
        depthCapWarned = true;
      }
      break;
    }

    frontier = nextFrontier;
  }

  if (Object.keys(merged).length === 0) return scan;

  let touched = false;
  const patched = scan.dependencies.map((d) => {
    if (d.ecosystem !== 'maven') return d;
    if (d.declaredVersion !== undefined) return d;
    const v = merged[d.name];
    if (v === undefined) return d;
    touched = true;
    return { ...d, declaredVersion: v };
  });
  if (!touched) return scan;

  return { ...scan, dependencies: patched };
}
