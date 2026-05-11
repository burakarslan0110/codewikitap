/**
 * Tool: find_neighbors
 *
 * Traverses the v2.1 knowledge graph. Input is a flat object with
 * `kind: z.enum([...])` plus per-kind required-field validation in the
 * handler — the MCP SDK's `inputSchema: ZodRawShape` does not accept
 * `z.discriminatedUnion`, so the per-kind sharpness is enforced
 * server-side (a missing required field becomes `isError: true`).
 *
 * Query kinds:
 *   - pages_referencing_file
 *   - diagram_neighbors
 *   - section_links
 *   - cross_repo
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { GraphQuery } from '../services/graph_query.js';
import type { ProjectScan } from '../types.js';
import { withMetrics } from './withMetrics.js';

export const findNeighborsToolName = 'find_neighbors';

const limitField = z.number().int().positive().max(64).optional();

/**
 * Flat input schema. The MCP SDK's `registerTool` consumes a `ZodRawShape`
 * (a `{[key]: ZodType}` map), which a `z.discriminatedUnion` does not
 * provide. Per-kind required fields are validated inside the handler, where
 * a thrown Zod error becomes an `isError: true` MCP response — same UX as
 * a true discriminated union from the agent's perspective.
 */
const inputSchema = z.object({
  kind: z
    .enum(['pages_referencing_file', 'diagram_neighbors', 'section_links', 'cross_repo'])
    .describe(
      'Query kind — each value requires its own co-fields:\n' +
        '- pages_referencing_file: requires file_path\n' +
        '- diagram_neighbors: requires repo + section_slug\n' +
        '- section_links: requires repo + section_slug\n' +
        '- cross_repo: requires repo\n' +
        'All other input fields (github_repo, diagram_node_id, direction, limit, query) are optional regardless of kind.',
    ),
  file_path: z
    .string()
    .optional()
    .describe('Required when kind=pages_referencing_file. Repo-relative file path whose referencing sections are returned.'),
  github_repo: z.string().optional(),
  repo: z
    .string()
    .optional()
    .describe('Required when kind ∈ {diagram_neighbors, section_links, cross_repo}. Canonical "<owner>/<repo>" of the wiki to traverse.'),
  section_slug: z
    .string()
    .optional()
    .describe('Required when kind ∈ {diagram_neighbors, section_links}. Heading slug anchoring the traversal.'),
  diagram_node_id: z
    .string()
    .optional()
    .describe(
      'Optional when kind=diagram_neighbors. Stable Graphviz node id (the SVG <title> / Mermaid alias, e.g. "ReactHooks.js"), NOT the human-readable label. Discover ids from get_page diagram text-fallback ("nodes: <id>=\\"<label>\\"") or the Mermaid block. Omit to return all diagram members of the section.',
    ),
  direction: z.enum(['in', 'out', 'both']).optional(),
  limit: limitField,
  /**
   * v2.5: optional natural-language query. When set, neighbors are
   * re-ranked by cosine similarity to the query against destination
   * section chunk text. Lazy-loads the embedder model on first use.
   * Without `query`, find_neighbors does NOT load the embedder
   * (preserves the v2.1 KG-only divergence invariant).
   */
  query: z.string().optional(),
});

type FindNeighborsInput = z.infer<typeof inputSchema>;

const KgNeighborSchema = z.object({
  kind: z.enum(['section', 'file', 'diagram_node', 'repo']),
  id: z.string(),
  label: z.string().optional(),
  edge_type: z.enum(['code_ref', 'diagram_edge', 'diagram_member', 'section_link', 'cross_repo_ref', 'dep_link']),
  direction: z.enum(['in', 'out']),
  repo: z.string().optional(),
  citation: z
    .object({ sourceUrl: z.string(), commitSha: z.string(), lastChecked: z.string() })
    .optional(),
  metadata: z.record(z.unknown()).optional(),
  /** v2.5: cosine similarity to the `query` arg; present iff query was passed. */
  score: z.number().optional(),
});

const outputSchema = z.object({
  query: z.unknown(),
  neighbors: z.array(KgNeighborSchema),
  truncated: z.boolean(),
  status: z.enum(['no_docs', 'rate_limited', 'retry', 'index_building']).optional(),
  retryAfterSeconds: z.number().optional(),
  reason: z.string().optional(),
});

export const findNeighborsToolDescription =
  'Traverse the CodeWiki knowledge graph: find pages referencing a file, diagram-node neighbors, intra-repo section links, or cross-repo references. Pass a query.kind plus its required fields. Always surface citation.sourceUrl.';

export interface FindNeighborsToolDeps {
  graphQuery: GraphQuery;
  /** Optional callback that returns the project scan (for the cross_repo dep_link derivation). */
  getProjectDeps?: () => ProjectScan;
}

export function registerFindNeighbors(server: McpServer, deps: FindNeighborsToolDeps): void {
  server.registerTool(
    findNeighborsToolName,
    {
      title: 'Knowledge graph traversal over CodeWiki documentation',
      description: findNeighborsToolDescription,
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withMetrics(findNeighborsToolName, async (args: FindNeighborsInput) => {
      const result = await dispatch(deps, args);
      const out = {
        query: args,
        neighbors: result.neighbors,
        truncated: result.truncated,
        ...(result.status ? { status: result.status } : {}),
        ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }),
  );
}

function requireField<T>(value: T | undefined, kind: string, fieldName: string): T {
  if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
    throw new Error(`find_neighbors[${kind}]: required field "${fieldName}" is missing`);
  }
  return value;
}

async function dispatch(
  deps: FindNeighborsToolDeps,
  args: FindNeighborsInput,
): Promise<Awaited<ReturnType<GraphQuery['pagesReferencingFile']>>> {
  switch (args.kind) {
    case 'pages_referencing_file':
      return deps.graphQuery.pagesReferencingFile({
        filePath: requireField(args.file_path, 'pages_referencing_file', 'file_path'),
        githubRepo: args.github_repo,
        limit: args.limit,
        query: args.query,
      });
    case 'diagram_neighbors':
      return deps.graphQuery.diagramNeighbors({
        repo: requireField(args.repo, 'diagram_neighbors', 'repo'),
        sectionSlug: requireField(args.section_slug, 'diagram_neighbors', 'section_slug'),
        diagramNodeId: args.diagram_node_id,
        limit: args.limit,
        query: args.query,
      });
    case 'section_links':
      return deps.graphQuery.sectionLinks({
        repo: requireField(args.repo, 'section_links', 'repo'),
        sectionSlug: requireField(args.section_slug, 'section_links', 'section_slug'),
        direction: args.direction,
        limit: args.limit,
        query: args.query,
      });
    case 'cross_repo':
      return deps.graphQuery.crossRepo({
        repo: requireField(args.repo, 'cross_repo', 'repo'),
        direction: args.direction,
        limit: args.limit,
        getProjectDeps: deps.getProjectDeps,
        query: args.query,
      });
  }
}
