/**
 * Tool: list_project_dependencies
 *
 * Scans the current project's manifest, resolves direct dependencies to
 * GitHub repos, and reports which have CodeWiki documentation.
 *
 * Description tuned to encourage agents to call this once on session start
 * (the v1 differentiator vs. reactive doc MCPs).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { scanProject, scanProjectRecursive } from '../services/project_scanner.js';
import { resolveRepo } from '../services/repo_resolver.js';
import { Cache } from '../services/cache.js';
import { CodeWikiClient } from '../services/codewiki_client.js';
import { enrichWithBomImports } from '../services/bom_resolver.js';
import { enrichWithParentPom } from '../services/parent_resolver.js';
import { detectFrameworks } from '../services/framework_detector.js';
import { Dependency, FrameworkContext, ProjectScan } from '../types.js';
import { INCLUDE_DEV_DEPS_DEFAULT } from '../config.js';
import { withMetrics } from './withMetrics.js';

// Exported so the unit test can assert the 240-char budget without coupling
// to the MCP server's private tool registry.
export const TOOL_DESCRIPTION =
  "Lists direct deps + framework context across ALL manifests under cwd. Polyglot monorepos return `manifests[]`; top-level fields project the cwd-nearest manifest. Flags: includeDev=true; includeOptional=false.";

const inputSchema = z.object({
  includeDev: z.boolean().optional(),
  includeOptional: z
    .boolean()
    .optional()
    .describe('v2.8: include npm optionalDependencies (kind:"optional"). Default true.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('v2.5: pagination offset; default 0. Pagination caps response size only — first page is NOT faster than no-pagination (full list always resolved server-side).'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('v2.5: max deps to return; default unlimited. Pair with `total` and `offset` to walk pages.'),
});
const depShape = z.object({
  name: z.string(),
  ecosystem: z.string(),
  resolvedRepo: z.string().nullable(),
  hasWiki: z.boolean().nullable(),
  pageCount: z.number().nullable(),
  kind: z.enum(['runtime', 'dev', 'optional']).optional(),
  declaredVersion: z.string().optional(),
});
const frameworkShape = z.object({
  name: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  sourceRepo: z.string(),
  detectedFrom: z.string(),
});
const manifestShape = z.object({
  projectRoot: z.string(),
  manifestType: z.string(),
  matchedManifestPath: z.string().optional(),
  dependencies: z.array(depShape),
  frameworks: z.array(frameworkShape),
});
const outputSchema = z.object({
  /** v0.6: cwd-nearest "primary" projection — first entry in `manifests[]`, or null when no manifest found. */
  projectRoot: z.string().nullable(),
  manifestType: z.string().nullable(),
  dependencies: z.array(depShape),
  /** Primary projection: count of `manifests[0].dependencies`. Legacy clients use this. */
  total: z.number().int().nonnegative(),
  /** v0.6: every root manifest discovered under cwd via recursive scan (with upward-walk fallback). */
  manifests: z.array(manifestShape),
  /** v0.6: total deps summed across all `manifests[i].dependencies`. */
  manifestsTotal: z.number().int().nonnegative(),
});

// Exported so the integration test can round-trip the response through
// `outputSchema.parse(...)` as the additive-schema smoke gate.
export const LIST_PROJECT_DEPENDENCIES_OUTPUT_SCHEMA = outputSchema;

export interface ToolDeps {
  cache: Cache;
  client: CodeWikiClient;
  cwd: string;
}

export function registerListProjectDependencies(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_project_dependencies',
    {
      title: 'List project dependencies (project-aware)',
      description: TOOL_DESCRIPTION,
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withMetrics('list_project_dependencies', async (args: { includeDev?: boolean; includeOptional?: boolean; offset?: number; limit?: number } | undefined) => {
      // Effective includeDev: explicit arg wins; else env-derived default.
      const effectiveIncludeDev =
        args?.includeDev !== undefined ? args.includeDev : INCLUDE_DEV_DEPS_DEFAULT;
      // Effective includeOptional: explicit arg wins; default true so npm
      // optionalDependencies (e.g. better-sqlite3) flow through by default.
      const effectiveIncludeOptional = args?.includeOptional !== false;
      const offset = Math.max(0, args?.offset ?? 0);
      const limit = args?.limit !== undefined && args.limit > 0 ? args.limit : undefined;
      const scanOpts = {
        includeDev: effectiveIncludeDev,
        includeOptional: effectiveIncludeOptional,
      };
      // v0.6: downward recursive scan first; fall back to upward walk only
      // when no manifest is found anywhere under cwd. Mirrors the polyglot-
      // monorepo + deep-subdir UX the user requested.
      let rawScans: ProjectScan[] = scanProjectRecursive(deps.cwd, scanOpts);
      if (rawScans.length === 0) {
        const upward = scanProject(deps.cwd, scanOpts);
        if (upward.projectRoot && upward.manifestType) rawScans = [upward];
      }

      // Per-scan enrichment + resolve+probe. Maven parent + BOM resolution
      // is preserved verbatim — runs ONCE per manifest, not flattened.
      const manifestEntries = await Promise.all(rawScans.map(async (raw) => {
        const parentEnriched = await enrichWithParentPom(raw, deps.cache);
        const scan = await enrichWithBomImports(parentEnriched, deps.cache);
        const resolvedDeps = await Promise.all(scan.dependencies.map((d) => resolveAndProbe(d, deps)));
        const frameworks: FrameworkContext[] = scan.manifestType
          ? detectFrameworks(scan.dependencies, scan.manifestType)
          : [];
        return {
          projectRoot: scan.projectRoot as string,
          manifestType: scan.manifestType as string,
          ...(scan.matchedManifestPath ? { matchedManifestPath: scan.matchedManifestPath } : {}),
          dependencies: resolvedDeps,
          frameworks,
        };
      }));

      // Top-level "primary projection" = manifests[0]. Pagination applied
      // ONLY to the primary's dependencies; manifests[1..] return full lists.
      // This keeps legacy single-manifest clients bit-equal AND keeps
      // ordering deterministic across paginated calls.
      const primary = manifestEntries[0];
      const primaryDeps = primary?.dependencies ?? [];
      const sliceEnd = limit !== undefined ? offset + limit : undefined;
      const pagedPrimary = primaryDeps.slice(offset, sliceEnd);
      const manifestsTotal = manifestEntries.reduce((acc, m) => acc + m.dependencies.length, 0);

      const result = {
        projectRoot: primary?.projectRoot ?? null,
        manifestType: primary?.manifestType ?? null,
        dependencies: pagedPrimary,
        total: primaryDeps.length,
        manifests: manifestEntries,
        manifestsTotal,
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }),
  );
}

async function resolveAndProbe(dep: Dependency, deps: ToolDeps): Promise<{
  name: string;
  ecosystem: string;
  resolvedRepo: string | null;
  hasWiki: boolean | null;
  pageCount: number | null;
  kind?: 'runtime' | 'dev' | 'optional';
  declaredVersion?: string;
}> {
  // Resolution cache hit?
  const cachedRepo = deps.cache.getRepo(dep.name, dep.ecosystem);
  let resolved: { owner: string; repo: string } | null = cachedRepo
    ? { owner: cachedRepo.owner, repo: cachedRepo.repo }
    : null;
  if (!resolved) {
    const r = await resolveRepo(dep.name, dep.ecosystem);
    if (r) {
      deps.cache.setRepo(dep.name, dep.ecosystem, r.owner, r.repo, r.source, r.confidence);
      resolved = { owner: r.owner, repo: r.repo };
    }
  }
  if (!resolved) {
    return { name: dep.name, ecosystem: dep.ecosystem, resolvedRepo: null, hasWiki: null, pageCount: null, kind: dep.kind, declaredVersion: dep.declaredVersion };
  }
  const repo = `${resolved.owner}/${resolved.repo}`;
  // Use the wiki_status cache directly so this stays cheap (no full page fetch).
  const status = deps.cache.getWikiStatus(repo);
  if (status) {
    return {
      name: dep.name,
      ecosystem: dep.ecosystem,
      resolvedRepo: repo,
      hasWiki: status.hasWiki,
      pageCount: status.pageCount,
      kind: dep.kind,
      declaredVersion: dep.declaredVersion,
    };
  }
  // Probe lazily — costs one Playwright page load per uncached dep on first call.
  try {
    const probe = await deps.client.probe(repo);
    if ('status' in probe) {
      return { name: dep.name, ecosystem: dep.ecosystem, resolvedRepo: repo, hasWiki: false, pageCount: 0, kind: dep.kind, declaredVersion: dep.declaredVersion };
    }
    return {
      name: dep.name,
      ecosystem: dep.ecosystem,
      resolvedRepo: repo,
      hasWiki: probe.hasWiki,
      pageCount: probe.pageCount,
      kind: dep.kind,
      declaredVersion: dep.declaredVersion,
    };
  } catch {
    // On probe failure (rate-limited, upstream down), report unknown rather than failing the whole tool.
    return { name: dep.name, ecosystem: dep.ecosystem, resolvedRepo: repo, hasWiki: null, pageCount: null, kind: dep.kind, declaredVersion: dep.declaredVersion };
  }
}
