/**
 * Tool: find_chunks
 *
 * Semantic retrieval over indexed CodeWiki pages. Returns ranked chunks with
 * anchored citations. Pass `repo` to scope; omit to query already-indexed
 * repos. Always surface citation.sourceUrl to the user.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { Retriever } from '../services/retriever.js';
import { withMetrics } from './withMetrics.js';

export const findChunksToolName = 'find_chunks';

const inputSchema = z.object({
  query: z.string().min(1).describe('Natural-language query to retrieve relevant chunks for.'),
  repo: z
    .string()
    .optional()
    .describe('Canonical "<owner>/<repo>" to scope retrieval. Omit to query already-indexed repos.'),
  k: z.number().int().positive().optional().describe('Max chunks to return (1–32). Default 8.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('v2.5: pagination offset; default 0. Pair with `total` in the response to walk pages.'),
});

const ChunkSchema = z.object({
  repo: z.string(),
  pageSlug: z.string(),
  sectionSlug: z.string(),
  ordinal: z.number(),
  /** Effective score = rerankScore on happy path, vectorScore when degraded. */
  score: z.number(),
  /** v2.6: cosine similarity (null on v2.7 BM25-only candidate). */
  vectorScore: z.number().nullable(),
  /** v2.6: cross-encoder rerank score; null when degraded fallback engaged. */
  rerankScore: z.number().nullable(),
  /** v2.7: inverted BM25 score; null when chunk came only from vector. */
  bm25Score: z.number().nullable().optional(),
  /** v2.7: 1-indexed rank in BM25 result list; null if vector-only. */
  bm25Rank: z.number().int().positive().nullable().optional(),
  /** v2.7: 1-indexed rank in vector result list; null if BM25-only. */
  vectorRank: z.number().int().positive().nullable().optional(),
  /** v2.7: Reciprocal Rank Fusion score. */
  rrfScore: z.number().nullable().optional(),
  text: z.string(),
  citation: z.object({ sourceUrl: z.string(), commitSha: z.string(), lastChecked: z.string() }),
});

const outputSchema = z.object({
  query: z.string(),
  repo: z.string().nullable(),
  chunks: z.array(ChunkSchema),
  /** v2.6: true when the response was capped by the rerank window. */
  truncated: z.boolean(),
  total: z.number().int().nonnegative(),
  /**
   * v2.6/v2.7: candidate-set size across all queried repos. Includes BOTH
   * vector-layer matches AND BM25-only matches (PSF-003 fix). Lower bound
   * on the true union — BM25-only rows beyond the per-call rerank window
   * are not observed and therefore not counted, so pagination clients see
   * a conservative count of remaining pages.
   */
  repoTotal: z.number().int().nonnegative().optional(),
  /** v2.6: true when the reranker failed and response is vector-ordered. */
  degraded: z.boolean().optional(),
  /** v2.7: which retrieval path produced this response. */
  hybrid: z.enum(['hybrid', 'vector_only', 'partial']).optional(),
  /** v2.7: audit field for hybrid debugging. */
  hybridStats: z
    .object({
      rrfK: z.number(),
      vectorCount: z.number(),
      bm25Count: z.number(),
      fusedCount: z.number(),
      perRepo: z.record(
        z.object({
          mode: z.enum(['hybrid', 'vector_only']),
          bm25Count: z.number().int().min(0),
        }),
      ),
    })
    .optional(),
  status: z.enum(['no_docs', 'rate_limited', 'retry', 'index_building']).optional(),
  retryAfterSeconds: z.number().optional(),
  reason: z.string().optional(),
});

export interface FindChunksToolDeps {
  retriever: Retriever;
}

export function registerFindChunks(server: McpServer, deps: FindChunksToolDeps): void {
  server.registerTool(
    findChunksToolName,
    {
      title: 'Semantic retrieval over CodeWiki documentation',
      description:
        'Semantic retrieval over indexed CodeWiki pages. Returns ranked chunks with anchored citations. Pass `repo` to scope; omit to query already-indexed repos. Always surface citation.sourceUrl to the user.',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    withMetrics(findChunksToolName, async (args: { query: string; repo?: string; k?: number; offset?: number }) => {
      const k = clamp(args.k ?? 8, 1, 32);
      const offset = Math.max(0, args.offset ?? 0);
      const result = await deps.retriever.findChunks(args.query, args.repo, k, { offset });
      const out = {
        query: args.query,
        repo: args.repo ?? null,
        chunks: result.chunks,
        truncated: result.truncated,
        total: result.total,
        ...(result.repoTotal !== undefined ? { repoTotal: result.repoTotal } : {}),
        ...(result.degraded ? { degraded: true } : {}),
        ...(result.hybrid ? { hybrid: result.hybrid } : {}),
        ...(result.hybridStats ? { hybridStats: result.hybridStats } : {}),
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

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
