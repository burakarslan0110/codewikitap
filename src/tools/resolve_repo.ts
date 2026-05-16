/**
 * Tool: resolve_repo
 *
 * Vague name → canonical github.com/owner/repo. Skip when caller already has
 * a slug. Used before get_page or find_chunks (which auto-indexes the repo).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { resolveRepo } from '../services/repo_resolver.js';
import { Ecosystem } from '../types.js';
import { Cache } from '../services/cache.js';
import { withMetrics } from './withMetrics.js';

const inputSchema = z.object({
  query: z.string().describe('Library name (e.g. "react") or full module path (e.g. "github.com/spf13/cobra").'),
  ecosystem: z.enum(['npm', 'pypi', 'go']).optional().describe('Ecosystem hint; npm assumed when omitted.'),
});

const outputSchema = z.object({
  owner: z.string().optional(),
  repo: z.string().optional(),
  source: z.string().optional(),
  confidence: z.string().optional(),
  status: z.literal('no_match').optional(),
  didYouMean: z.array(z.string()).optional(),
});

export interface ToolDeps {
  cache: Cache;
}

export function registerResolveRepo(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'resolve_repo',
    {
      title: 'Resolve a library name to github.com/owner/repo',
      description:
        'Resolve a vague library name to a canonical github.com/owner/repo. Skip when caller already has owner/repo. Use before get_page or find_chunks.',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withMetrics('resolve_repo', async ({ query, ecosystem }: { query: string; ecosystem?: 'npm' | 'pypi' | 'go' }) => {
      const eco: Ecosystem = ecosystem ?? 'npm';
      const cached = deps.cache.getRepo(query, eco);
      if (cached) {
        const result = {
          owner: cached.owner,
          repo: cached.repo,
          source: cached.source,
          confidence: cached.confidence,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      }
      const r = await resolveRepo(query, eco);
      if (!r) {
        const result = { status: 'no_match' as const, didYouMean: [] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
      }
      deps.cache.setRepo(query, eco, r.owner, r.repo, r.source, r.confidence);
      const result = { owner: r.owner, repo: r.repo, source: r.source, confidence: r.confidence };
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], structuredContent: result };
    }),
  );
}
