/**
 * Tool: get_page.
 *
 * Three operating modes selected by inputs:
 *   - `prepareOnly: true` (v0.7) → pre-warm the index for the repo. Sync race
 *     against INDEX_BUILD_TIMEOUT_MS; returns `{ status: 'ready', chunkCount,
 *     edgeCount }` or `{ status: 'index_building' }`. Replaces the v0.6
 *     `request_indexing` tool. Side effect: HTTP fetch + sqlite write.
 *   - `listPages: true` → returns the page index (table of contents).
 *   - Otherwise (default) → fetches one CodeWiki page or sub-section subtree.
 *     `slug` selects the top-level page; `subsection` drills into a heading.
 *
 * Annotations: `readOnlyHint: false` — `prepareOnly` triggers a write path.
 * `idempotentHint: true` — Indexer.indexRepo's single-flight + TTL-based
 * freshness short-circuit guarantee that repeated calls within INDEX_TTL_MS
 * are no-ops.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CodeWikiClient } from '../services/codewiki_client.js';
import type { Indexer, IndexerResult } from '../services/indexer.js';
import { serialize } from '../extraction/serializer.js';
import { DEFAULT_MAX_TOKENS } from '../config.js';
import { INDEX_BUILD_TIMEOUT_MS } from '../config_rag.js';
import type { Fallback } from '../types.js';
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
    .describe('Deeper heading slug — when given, returns only that subsection subtree.'),
  maxTokens: z.number().int().positive().optional().describe('Token budget (estimate). Default 8000.'),
  listPages: z
    .boolean()
    .optional()
    .describe('When true, returns the page index (table of contents) for this repo instead of fetching a page. Other args ignored.'),
  prepareOnly: z
    .boolean()
    .optional()
    .describe(
      'When true, pre-warms the index for `repo` (HTTP fetch + sqlite write). Sync race against INDEX_BUILD_TIMEOUT_MS; returns status:ready or status:index_building. Idempotent via single-flight + TTL — safe to retry. Use only when find_chunks reported status:index_building and you need a guaranteed cache hit.',
    ),
});

const FallbacksSchema = z.array(
  z.object({
    kind: z.enum(['github_readme', 'request_indexing']),
    url: z.string().url(),
    label: z.string().optional(),
  }),
);

const PageIndexEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  level: z.number(),
  parentSlug: z.string().nullable(),
  hasDiagrams: z.boolean(),
});

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
  // Page-index branch output (listPages: true).
  pageIndex: z.array(PageIndexEntrySchema).optional(),
  // v0.7 prepareOnly fields.
  chunkCount: z.number().int().nonnegative().optional(),
  edgeCount: z.number().int().nonnegative().optional(),
  status: z
    .enum(['ready', 'index_building', 'no_docs', 'rate_limited', 'retry', 'no_match', 'no_wiki'])
    .optional(),
  fallbacks: FallbacksSchema.optional(),
  retryAfterSeconds: z.number().optional(),
  estimatedRemainingSeconds: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});

export interface ToolDeps {
  client: CodeWikiClient;
  indexer: Pick<Indexer, 'indexRepo' | 'estimateRemainingMs'>;
}

export interface GetPageToolOptions {
  /** Test seam: override INDEX_BUILD_TIMEOUT_MS for the prepareOnly race. */
  prepareTimeoutMs?: number;
}

export function registerGetPage(
  server: McpServer,
  deps: ToolDeps,
  opts: GetPageToolOptions = {},
): void {
  const prepareTimeoutMs = opts.prepareTimeoutMs ?? INDEX_BUILD_TIMEOUT_MS;

  server.registerTool(
    'get_page',
    {
      title: 'Get a CodeWiki page, sub-section, page index, or pre-warm its index',
      description:
        'Fetch a CodeWiki page by slug; set listPages:true for the page index; set prepareOnly:true to pre-warm the index without returning page content (side effect: HTTP fetch + sqlite write, subject to CodeWiki rate-limit 1 page/4s per origin). Always surface citation.sourceUrl.',
      inputSchema: inputSchema.shape,
      outputSchema: outputSchema.shape,
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    withMetrics(
      'get_page',
      async ({
        repo,
        slug,
        subsection,
        maxTokens,
        listPages,
        prepareOnly,
      }: {
        repo: string;
        slug?: string;
        subsection?: string;
        maxTokens?: number;
        listPages?: boolean;
        prepareOnly?: boolean;
      }) => {
        // v0.7 mutex validation: prepareOnly and listPages are mutually
        // exclusive — one is a write path (HTTP fetch + sqlite write), the
        // other is a read-only page-index query. Silently preferring one over
        // the other (as an earlier draft did) hid agent bugs; throw instead so
        // the MCP SDK translates to isError:true with a clear message.
        if (prepareOnly === true && listPages === true) {
          throw new Error(
            'get_page: `prepareOnly` and `listPages` are mutually exclusive. Pass one or neither, not both.',
          );
        }

        // v0.7 prepareOnly branch — sits BEFORE listPages (more side-effecting,
        // so fail-fast). Mirrors the v0.6 request_indexing.ts:80-160 contract,
        // plus the v0.7 reviewer addition: surface `estimatedRemainingSeconds`
        // on the index_building envelope (sourced from indexer's rolling
        // window) so agents can decide between waiting vs retrying.
        if (prepareOnly === true) {
          const raceStartedAt = Date.now();
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

          const raced = await Promise.race([
            buildPromise.then(
              (r) => ({ kind: 'done' as const, result: r }),
              (err: unknown) => ({ kind: 'error' as const, err }),
            ),
            new Promise<{ kind: 'timeout' }>((resolve) =>
              setTimeout(() => resolve({ kind: 'timeout' as const }), prepareTimeoutMs),
            ),
          ]);

          let out: {
            repo: string;
            status: 'ready' | 'index_building' | 'no_docs' | 'rate_limited' | 'retry';
            chunkCount?: number;
            edgeCount?: number;
            retryAfterSeconds?: number;
            estimatedRemainingSeconds?: number;
            fallbacks?: Fallback[];
            reason?: string;
          };

          if (raced.kind === 'timeout') {
            const elapsed = Date.now() - raceStartedAt;
            const remainingMs = deps.indexer.estimateRemainingMs(elapsed);
            out = {
              repo,
              status: 'index_building',
              estimatedRemainingSeconds: Math.ceil(remainingMs / 1000),
            };
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
        }

        // Page-index branch.
        if (listPages === true) {
          const r = await deps.client.listPages(repo);
          return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }], structuredContent: r };
        }
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
      },
    ),
  );
}
