/**
 * Audit scenarios shared infrastructure.
 *
 * Each AUDIT_TS_NNN id is the public name for a regression scenario locked
 * in `tests/audit/*.audit.test.ts`. Files in this directory are NOT picked
 * up by `pnpm test` / `pnpm test:integration` / `pnpm test:all`; only
 * `pnpm run audit` runs them via the `audit` workspace project.
 *
 * Build-time note for cold-start (AUDIT_TS_009): the `performance.audit.test.ts`
 * file unconditionally runs `pnpm build` in `beforeAll` and captures the
 * elapsed millis as `audit.build_ms`. That metric is EXCLUDED from the 15s
 * cold-start budget (which covers only spawn → handshake). See the header
 * comment in `performance.audit.test.ts` for the exact harness.
 *
 * Live-mode opt-in: scenarios touching the real CodeWiki origin gate on
 * `process.env.CODEWIKI_AUDIT_LIVE === '1'`. Default `pnpm run audit` uses
 * jsdom fixtures + the mocked-fetchPage seam from existing integration
 * tests so a full run is offline-deterministic.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import type { CanonicalNode, ExtractionResult } from '../../src/extraction/canonical_tree.js';

export const AUDIT_SCENARIOS = {
  AUDIT_TS_001: 'Version drift detection across four sources',
  AUDIT_TS_002: 'list_project_dependencies happy + degraded paths',
  AUDIT_TS_003: 'resolve_repo happy + degraded paths',
  AUDIT_TS_004: 'get_page listPages happy + degraded paths',
  AUDIT_TS_005: 'get_page happy + degraded paths',
  AUDIT_TS_006: 'find_chunks happy + degraded paths',
  AUDIT_TS_007: 'find_neighbors happy + degraded paths',
  AUDIT_TS_008: 'request_indexing happy + degraded paths',
  AUDIT_TS_009: 'Cold-start <= 15s (process start to first tools/list response)',
  AUDIT_TS_010: 'find_chunks warm P95 <= 2s (mocked deps, hybrid path)',
  AUDIT_TS_011: 'get_page warm P95 <= 1s (cache hit)',
  AUDIT_TS_012: 'Indexer build <= 8s (small fixture, mocked embedder)',
  AUDIT_TS_013: 'Single-flight collapses concurrent indexRepo calls to 1 fetch',
  AUDIT_TS_014: 'Rate limit honored (1 page-load / 4s / origin)',
  AUDIT_TS_015: 'Citation footer byte-equal across get_page + find_chunks',
  AUDIT_TS_016: 'Chunker section coverage (every HeadingNode with content -> >=1 chunk)',
  AUDIT_TS_017: 'RRF fusion ranking determinism (known input -> known output)',
  AUDIT_TS_018: 'truncated invariant unified across happy + offset-beyond-window paths',
  AUDIT_TS_019: 'repoTotal includes BM25-only chunks (hybrid)',
  AUDIT_TS_020: 'Empty commitSha routes to status=retry (no broken footer)',
  AUDIT_TS_021: 'find_neighbors query → score field on section/diagram_node; absent on file/repo',
  AUDIT_TS_022: 'find_neighbors semantic-rank ordering quality on deterministic fixture',
  AUDIT_TS_023: 'find_neighbors WITHOUT query does NOT load embedder (lazy-load divergence)',
  AUDIT_TS_024: 'find_neighbors with embedder error → status=retry + retryAfterSeconds=60',
  AUDIT_TS_025: 'graph_extractor emits code_ref + cross_repo_ref from prose-level github blob URLs',
  AUDIT_TS_026: 'dom_to_tree extracts diagram nodes/edges from base64-wrapped Graphviz SVG',
  AUDIT_TS_027: 'cross_repo_ref kinds union deduplicates code_block + anchor_link + prose_link to one row',
  AUDIT_TS_028: 'find_neighbors returns >=1 neighbor for all 4 query kinds against fully-populated synthetic fixture',
} as const;

export type AuditScenarioId = keyof typeof AUDIT_SCENARIOS;

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function readPackageJson(): { name: string; version: string } {
  const raw = fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf-8');
  const parsed = JSON.parse(raw) as { name: string; version: string };
  return { name: parsed.name, version: parsed.version };
}

/**
 * Read the most recent codewiki-mcp plan file's Status header.
 * Returns 'VERIFIED' | 'COMPLETE' | 'PENDING' | null.
 */
export function readLatestPlanStatus(slugContains: string): { file: string; status: string } | null {
  const plansDir = path.join(repoRoot(), 'docs', 'plans');
  if (!fs.existsSync(plansDir)) return null;
  const files = fs
    .readdirSync(plansDir)
    .filter((f) => f.endsWith('.md') && f.includes(slugContains))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  const file = files[0];
  const raw = fs.readFileSync(path.join(plansDir, file), 'utf-8');
  const m = raw.match(/^Status:\s*(\w+)\s*$/m);
  return { file, status: m ? m[1] : 'UNKNOWN' };
}

/**
 * Shared fixture node tree mirroring the v2.6/v2.7 integration tests.
 * Use via `fixtureExtraction()` to get a deterministic ExtractionResult.
 */
const FIXTURE_NODES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'overview', markdown: 'Audit fixture overview prose.' },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core module: authentication, login, session management.' },
  {
    type: 'code',
    sectionSlug: 'core',
    language: 'ts',
    text: "export function authenticate(token: string): User { return verify(token); }",
    github: { repo: 'audit/fixture', sha: 'a'.repeat(40), path: 'src/auth.ts' },
  },
  { type: 'heading', sectionSlug: 'core-hooks', slug: 'core-hooks', title: 'Hooks', level: 3, parentSlug: 'core', hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core-hooks', markdown: 'useAuth, useSession hooks for React integration.' },
  { type: 'heading', sectionSlug: 'api', slug: 'api', title: 'API', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'api', markdown: 'Public API surface for the audit fixture repo.' },
];

export function fixtureExtraction(): ExtractionResult {
  return {
    nodes: FIXTURE_NODES,
    notFound: false,
    emptyShell: false,
    firstCommitSha: 'a'.repeat(40),
  };
}

/**
 * AUDIT_TS_021..024 fixture: same shape as `fixtureExtraction()` but adds
 * `[text](#anchor)` markdown anchors in the `overview` prose so the canonical-
 * tree extractor emits `section_link` edges (`overview` → `core` and `overview`
 * → `api`). Section_links queries on the `overview` section therefore return
 * two non-trivial section neighbors, giving semantic-rank a real ranking
 * choice. Required by AUDIT_TS_021 (score-field shape on multi-neighbor sets)
 * and AUDIT_TS_022 (ordering-quality assertion).
 */
const FIXTURE_NODES_WITH_KG_EDGES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  {
    type: 'prose',
    sectionSlug: 'overview',
    markdown: 'Overview prose. See [core](#core) for entry-point details and [api](#api) for the public surface.',
  },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core module: authentication, login, session management. Entry point architecture.' },
  {
    type: 'code',
    sectionSlug: 'core',
    language: 'ts',
    text: "export function authenticate(token: string): User { return verify(token); }",
    github: { repo: 'audit/fixture', sha: 'a'.repeat(40), path: 'src/auth.ts' },
  },
  { type: 'heading', sectionSlug: 'core-hooks', slug: 'core-hooks', title: 'Hooks', level: 3, parentSlug: 'core', hasDiagrams: false },
  {
    type: 'prose',
    sectionSlug: 'core-hooks',
    markdown: 'useAuth, useSession hooks for React integration. See [react hooks](https://codewiki.google/github.com/facebook/react#hooks) for the upstream library.',
  },
  { type: 'heading', sectionSlug: 'api', slug: 'api', title: 'API', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'api', markdown: 'Public API surface for the audit fixture repo.' },
];

export function fixtureExtractionWithKgEdges(): ExtractionResult {
  return {
    nodes: FIXTURE_NODES_WITH_KG_EDGES,
    notFound: false,
    emptyShell: false,
    firstCommitSha: 'a'.repeat(40),
  };
}

/**
 * v2.8: synthetic canonical tree exercising EVERY stored edge type at once.
 *
 *   - `overview` has anchor links to `core` and `api` → section_link x2.
 *   - `core` prose carries a same-repo github blob URL → code_ref to
 *     `audit/fixture:src/babel/Plugin.ts`, AND a cross-repo github blob URL
 *     → code_ref + cross_repo_ref{kinds:[prose_link]} for `facebook/react`,
 *     AND a CodeWiki cross-repo URL → cross_repo_ref{kinds:[anchor_link]}.
 *     The merge invariant: all three foreign-repo signals dedup into ONE
 *     cross_repo_ref row whose `kinds` is the sorted union
 *     `['anchor_link', 'code_block', 'prose_link']`.
 *   - `core` carries a CodeNode pointing at the same `facebook/react` file
 *     → code_block kind added to the merge.
 *   - `core` carries a DiagramNode with 2 nodes (n1, n2) + 1 edge (n1->n2)
 *     → diagram_member x2 + diagram_edge x1.
 *   - `core-internals` is nested under `core` (parentSlug='core') with a
 *     same-repo anchor link back to `core` → section_link.
 *
 * Required by AUDIT_TS_025..028 (extractor + integration coverage).
 */
const PROD_SHA = 'd5736f098edee62c44f27b053e6e48f5fa443803';
const FIXTURE_NODES_FULL_EDGE_TYPES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  {
    type: 'prose',
    sectionSlug: 'overview',
    markdown: 'Overview. See [Core](#core) and [API](#api) for details.',
  },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: true },
  {
    type: 'prose',
    sectionSlug: 'core',
    markdown:
      `Entry point in [BabelPlugin](https://github.com/audit/fixture/blob/${PROD_SHA}/src/babel/Plugin.ts#L24). ` +
      `Reference [react useState](https://github.com/facebook/react/blob/${PROD_SHA}/packages/react/src/index.ts) ` +
      `and [also react](https://codewiki.google/github.com/facebook/react#hooks) for the upstream library.`,
  },
  {
    type: 'code',
    sectionSlug: 'core',
    language: 'ts',
    text: 'export function entry() { return 42; }',
    github: {
      repo: 'facebook/react',
      sha: PROD_SHA,
      path: 'packages/react/src/index.ts',
    },
  },
  {
    type: 'diagram',
    sectionSlug: 'core',
    nodes: [
      { id: 'n1', label: 'Start' },
      { id: 'n2', label: 'End' },
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    lossy: false,
  },
  { type: 'heading', sectionSlug: 'core-internals', slug: 'core-internals', title: 'Internals', level: 3, parentSlug: 'core', hasDiagrams: false },
  {
    type: 'prose',
    sectionSlug: 'core-internals',
    markdown: 'Internals are nested under [Core](#core).',
  },
  { type: 'heading', sectionSlug: 'api', slug: 'api', title: 'API', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'api', markdown: 'Public API surface for the audit fixture repo.' },
];

export function fixtureExtractionFullEdgeTypes(): ExtractionResult {
  return {
    nodes: FIXTURE_NODES_FULL_EDGE_TYPES,
    notFound: false,
    emptyShell: false,
    firstCommitSha: PROD_SHA,
  };
}

export function notFoundExtraction(): ExtractionResult {
  return { nodes: [], notFound: true, emptyShell: false, firstCommitSha: null };
}

export interface TempDirs {
  projectDir: string;
  cacheDir: string;
  cleanup(): void;
}

export function mkTempDirs(prefix = 'codewiki-audit'): TempDirs {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-proj-`));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-cache-`));
  return {
    projectDir,
    cacheDir,
    cleanup() {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    },
  };
}

export function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

export const STRICT_THRESHOLDS = {
  COLD_START_MS: 15_000,
  FIND_CHUNKS_WARM_P95_MS: 2_000,
  GET_PAGE_WARM_P95_MS: 1_000,
  INDEXER_BUILD_MS: 8_000,
} as const;
