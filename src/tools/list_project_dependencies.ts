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

import { scanProject } from '../services/project_scanner.js';
import { resolveRepo } from '../services/repo_resolver.js';
import { Cache } from '../services/cache.js';
import { CodeWikiClient } from '../services/codewiki_client.js';
import { enrichWithBomImports } from '../services/bom_resolver.js';
import { enrichWithParentPom } from '../services/parent_resolver.js';
import { Dependency } from '../types.js';
import { INCLUDE_DEV_DEPS_DEFAULT } from '../config.js';
import { withMetrics } from './withMetrics.js';

// Exported so the unit test can assert the 240-char budget without coupling
// to the MCP server's private tool registry.
export const TOOL_DESCRIPTION =
  "List the project's direct deps and which have Google CodeWiki docs. npm/pnpm/yarn workspaces, PyPI/Poetry, Go (+go.work), Cargo, Composer, Maven (BOM), Gradle, RubyGems, NuGet (sln+CPM). Flags: includeDev=true; includeOptional=false.";

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
const outputSchema = z.object({
  projectRoot: z.string().nullable(),
  manifestType: z.string().nullable(),
  dependencies: z.array(
    z.object({
      name: z.string(),
      ecosystem: z.string(),
      resolvedRepo: z.string().nullable(),
      hasWiki: z.boolean().nullable(),
      pageCount: z.number().nullable(),
      kind: z.enum(['runtime', 'dev', 'optional']).optional(),
      declaredVersion: z.string().optional(),
    }),
  ),
  total: z.number().int().nonnegative(),
});

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
      const initialScan = scanProject(deps.cwd, {
        includeDev: effectiveIncludeDev,
        includeOptional: effectiveIncludeOptional,
      });
      // v2.5: parent POM resolution runs FIRST. enrichWithParentPom (a) patches
      // dep.declaredVersion entries from the parent's literal <dependencyManagement>
      // (preserving any version the child already set), and (b) APPENDS the
      // parent's nested <scope>import</scope> BOMs onto scan.bomImports so the
      // recursive bom_resolver walker (running NEXT) sees them at depth 0
      // alongside the child's own BOMs. Spring Boot Starter Parent canonical
      // pattern — parent has no literal DM versions, only a <scope>import</scope>
      // of spring-boot-dependencies — works end-to-end via this chain.
      // v2.4: BOM enrichment runs between scan and resolve so resolved repos
      // see post-BOM `declaredVersion` (defense-in-depth — current resolvers
      // do not consume declaredVersion, but the contract surfaces it to MCP
      // clients downstream).
      const parentEnriched = await enrichWithParentPom(initialScan, deps.cache);
      const scan = await enrichWithBomImports(parentEnriched, deps.cache);
      // v2.5: full pipeline runs to completion (preserves the v1 list-everything
      // promise + caches resolves for subsequent pages); slice happens after.
      // Pagination caps response SIZE only, not first-page latency.
      const allOut = await Promise.all(scan.dependencies.map((d) => resolveAndProbe(d, deps)));
      const total = allOut.length;
      const sliceEnd = limit !== undefined ? offset + limit : undefined;
      const out = allOut.slice(offset, sliceEnd);
      const result = {
        projectRoot: scan.projectRoot,
        manifestType: scan.manifestType,
        dependencies: out,
        total,
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
