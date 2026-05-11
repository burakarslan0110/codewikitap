/**
 * Tool: request_indexing (v2.6 — the 7th MCP tool).
 *
 * Pre-warm the CodeWiki index for a known target repo. Sync race against
 * INDEX_BUILD_TIMEOUT_MS mirroring the find_chunks contract: when the build
 * finishes within the window, returns { status: 'ready', chunkCount, edgeCount };
 * on timeout, returns { status: 'index_building' } and the build continues in
 * the background (single-flight collapses follow-up calls).
 *
 * THIS IS THE FIRST NON-READONLY MCP TOOL on the surface. Annotations are
 * { readOnlyHint: false, idempotentHint: true }. Idempotency comes from
 * Indexer.indexRepo's single-flight + TTL-based freshness short-circuit:
 * repeated calls within INDEX_TTL_MS for a fresh repo are no-ops.
 *
 * The tool description explicitly warns about CodeWiki rate-limit interaction
 * (1 page-load per 4s per origin via RATE_LIMIT_INTERVAL_MS in CodeWikiClient).
 * Auto-execution in tight loops will trip the gate.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Indexer, IndexerResult } from '../services/indexer.js';
import { INDEX_BUILD_TIMEOUT_MS } from '../config_rag.js';
import type { Fallback } from '../types.js';
import { withMetrics } from './withMetrics.js';

export const requestIndexingToolName = 'request_indexing';

const inputSchema = z.object({
  repo: z
    .string()
    .min(1)
    .regex(/^[^/]+\/[^/]+$/, 'expected canonical "<owner>/<repo>"')
    .describe(
      'Canonical "<owner>/<repo>" identifier for the target repository. Triggers a CodeWiki fetch + sqlite write. Subject to CodeWiki rate-limit (1 page/4s per origin); use sparingly, avoid auto-execution in loops.',
    ),
});

const FallbackSchema = z.object({
  kind: z.enum(['github_readme', 'request_indexing']),
  url: z.string().optional(),
  hint: z.string().optional(),
});

const outputSchema = z.object({
  repo: z.string(),
  status: z.enum(['ready', 'index_building', 'no_docs', 'rate_limited', 'retry']),
  chunkCount: z.number().int().nonnegative().optional(),
  edgeCount: z.number().int().nonnegative().optional(),
  retryAfterSeconds: z.number().optional(),
  fallbacks: z.array(FallbackSchema).optional(),
  reason: z.string().optional(),
});

export interface RequestIndexingToolDeps {
  indexer: Pick<Indexer, 'indexRepo'>;
}

export interface RequestIndexingToolOptions {
  /** Test seam: override the default INDEX_BUILD_TIMEOUT_MS for the race. */
  timeoutMs?: number;
}

export function registerRequestIndexing(
  server: McpServer,
  deps: RequestIndexingToolDeps,
  opts: RequestIndexingToolOptions = {},
): void {
  const timeoutMs = opts.timeoutMs ?? INDEX_BUILD_TIMEOUT_MS;

  server.registerTool(
    requestIndexingToolName,
    {
      title: 'Pre-warm the CodeWiki index for a repo',
      description:
        'Pre-warm the CodeWiki index for a repo before find_chunks/find_neighbors. Sync race against INDEX_BUILD_TIMEOUT_MS (~5s); returns status=ready or status=index_building. Side effect: HTTP fetch + sqlite write. Subject to CodeWiki rate-limit (1 page/4s per origin). Idempotent via single-flight + TTL; safe to retry. Use sparingly — do NOT auto-execute in loops.',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    withMetrics(requestIndexingToolName, async (args: { repo: string }) => {
      const repo = args.repo;

      let buildPromise: Promise<IndexerResult>;
      try {
        buildPromise = deps.indexer.indexRepo(repo);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const out = {
          repo,
          status: 'retry' as const,
          retryAfterSeconds: 60,
          reason: `indexer threw: ${reason}`,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
          structuredContent: out,
        };
      }

      // Race the build against the timeout — same shape as the retriever's
      // resolveTargetRepos single-repo branch.
      const raced = await Promise.race([
        buildPromise.then(
          (r) => ({ kind: 'done' as const, result: r }),
          (err: unknown) => ({ kind: 'error' as const, err }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' as const }), timeoutMs),
        ),
      ]);

      let out: {
        repo: string;
        status: 'ready' | 'index_building' | 'no_docs' | 'rate_limited' | 'retry';
        chunkCount?: number;
        edgeCount?: number;
        retryAfterSeconds?: number;
        fallbacks?: Fallback[];
        reason?: string;
      };

      if (raced.kind === 'timeout') {
        out = { repo, status: 'index_building' };
      } else if (raced.kind === 'error') {
        const err = raced.err;
        const reason = err instanceof Error ? err.message : String(err);
        out = { repo, status: 'retry', retryAfterSeconds: 60, reason };
      } else {
        const r = raced.result;
        switch (r.status) {
          case 'ready':
            out = {
              repo,
              status: 'ready',
              chunkCount: r.chunkCount,
              ...(r.edgeCount !== undefined ? { edgeCount: r.edgeCount } : {}),
            };
            break;
          case 'no_docs':
            out = { repo, status: 'no_docs', fallbacks: r.fallbacks };
            break;
          case 'rate_limited':
            out = { repo, status: 'rate_limited', retryAfterSeconds: r.retryAfterSeconds };
            break;
          case 'retry':
            out = {
              repo,
              status: 'retry',
              retryAfterSeconds: r.retryAfterSeconds,
              reason: r.reason,
            };
            break;
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
        structuredContent: out,
      };
    }),
  );
}
