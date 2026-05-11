/**
 * Tool: list_pages
 *
 * Returns the page index (table of contents) for a repository's CodeWiki.
 * Cheap; call before get_page to discover slugs.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CodeWikiClient } from '../services/codewiki_client.js';
import { withMetrics } from './withMetrics.js';

const inputSchema = z.object({
  repo: z.string().describe('Canonical "<owner>/<repo>" identifier (e.g. "facebook/react").'),
});

const outputSchema = z.object({
  repo: z.string(),
  pageIndex: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      level: z.number(),
      parentSlug: z.string().nullable(),
      hasDiagrams: z.boolean(),
    }),
  ),
  status: z.literal('no_wiki').optional(),
});

export interface ToolDeps {
  client: CodeWikiClient;
}

export function registerListPages(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'list_pages',
    {
      title: 'List CodeWiki pages for a repository',
      description:
        "Return the page index (table of contents) for a repository's CodeWiki. Cheap; call before get_page to discover slugs.",
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withMetrics('list_pages', async ({ repo }: { repo: string }) => {
      const r = await deps.client.listPages(repo);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: r };
    }),
  );
}
