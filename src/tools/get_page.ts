/**
 * Tool: get_page
 *
 * Fetch one CodeWiki page (or a sub-section subtree) for a repository.
 * Supports heading-aware drill-down via the optional `subsection` slug.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CodeWikiClient } from '../services/codewiki_client.js';
import { serialize } from '../extraction/serializer.js';
import { DEFAULT_MAX_TOKENS } from '../config.js';
import { withMetrics } from './withMetrics.js';

const inputSchema = z.object({
  repo: z.string().describe('Canonical "<owner>/<repo>" identifier.'),
  slug: z
    .string()
    .optional()
    .describe('Top-level page slug within the repo wiki. Omit to fetch the root/overview page.'),
  subsection: z
    .string()
    .optional()
    .describe('Deeper heading slug from list_pages — when given, returns only that subsection subtree.'),
  maxTokens: z.number().int().positive().optional().describe('Token budget (estimate). Default 8000.'),
});

const FallbacksSchema = z.array(
  z.object({
    kind: z.enum(['github_readme', 'request_indexing']),
    url: z.string().url(),
    label: z.string().optional(),
  }),
);

const outputSchema = z.object({
  repo: z.string().optional(),
  slug: z.string().optional(),
  subsection: z.string().nullable().optional(),
  content: z.object({ type: z.literal('markdown'), markdown: z.string() }).optional(),
  citation: z
    .object({ sourceUrl: z.string(), commitSha: z.string(), lastChecked: z.string() })
    .optional(),
  truncated: z.boolean().optional(),
  availableSubsections: z.array(z.string()).optional(),
  status: z.enum(['no_docs', 'rate_limited', 'retry', 'no_match']).optional(),
  fallbacks: FallbacksSchema.optional(),
  retryAfterSeconds: z.number().optional(),
  reason: z.string().optional(),
});

export interface ToolDeps {
  client: CodeWikiClient;
}

export function registerGetPage(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_page',
    {
      title: 'Get a CodeWiki page or sub-section',
      description:
        'Fetch one CodeWiki page or sub-section by slug. Pass `subsection` (a deeper slug from list_pages) for narrow drill-down. Always surface the returned citation URL to the user.',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withMetrics('get_page', async ({ repo, slug, subsection, maxTokens }: { repo: string; slug?: string; subsection?: string; maxTokens?: number }) => {
      const r = await deps.client.getPage(repo, slug, subsection);
      if ('status' in r) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: r };
      }
      // PSF-004 layer 2 (Codex finding): get_page must map empty-SHA cases
      // to a retry envelope rather than letting the serializer's layer-3
      // throw escape as an exception. The CodeWikiClient extraction can
      // produce a PageResult with commitSha:'' when firstCommitSha is null
      // upstream (e.g. a freshly-published page with no commit anchor).
      if (!/^[0-9a-f]{40}$/.test(r.citation.commitSha)) {
        const retryOut = {
          repo: r.repo,
          slug: r.slug,
          status: 'retry' as const,
          retryAfterSeconds: 60,
          reason: `empty_commit_sha: upstream page returned commitSha=${JSON.stringify(r.citation.commitSha)} which is not a 40-char hex SHA`,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(retryOut, null, 2) }], structuredContent: retryOut };
      }
      const serialized = serialize(r.nodes, r.citation, {
        maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      });
      const out = {
        repo: r.repo,
        slug: r.slug,
        subsection: r.subsection,
        content: { type: 'markdown' as const, markdown: serialized.markdown },
        citation: r.citation,
        truncated: serialized.truncated,
        availableSubsections: r.availableSubsections,
      };
      return { content: [{ type: 'text' as const, text: serialized.markdown }], structuredContent: out };
    }),
  );
}
