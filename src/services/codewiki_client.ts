/**
 * High-level CodeWiki orchestrator. Composes playwright_driver + cache +
 * extraction.dom_to_tree + extraction.sub_section into the surface that
 * MCP tools call: probe(repo), listPages(repo), getPage(repo, slug?, subsection?).
 *
 * Implements the cache contract from the plan (Scope line 36 + Task 10):
 *   - Cache MISS         → full fetch, store, return.
 *   - Cache HIT, fresh   → return immediately, NO upstream call.
 *   - Cache HIT, expired → SHA-only probe; same SHA → refresh fetched_at and
 *                          return cached body; different SHA → full re-fetch.
 *
 * Single-flight: in-memory Map collapses duplicate concurrent requests for
 * the same (repo, slug) — the agent-loop bug Cloudmeru fixed in v1.0.3.
 */

import type { Page } from 'playwright';

import { Cache } from './cache.js';
import { PlaywrightDriver, getPlaywrightDriver } from '../adapters/playwright_driver.js';
import { extractFromPage } from '../extraction/dom_to_tree.js';
import { subtreeFor } from '../extraction/sub_section.js';
import {
  CanonicalNode,
  ExtractionResult,
  HeadingNode,
} from '../extraction/canonical_tree.js';
import {
  Citation,
  CodeWikiError,
  Fallback,
  PageIndexEntry,
  PlaywrightUnavailableError,
} from '../types.js';
import {
  CODEWIKI_BASE_URL,
  PAGE_TTL_MS,
  WIKI_STATUS_TTL_MS,
  RATE_LIMIT_INTERVAL_MS,
} from '../config.js';

export interface ProbeResult {
  hasWiki: boolean;
  pageCount: number;
  pageIndex: PageIndexEntry[];
  fallbacks?: Fallback[];
}

export interface PageResult {
  repo: string;
  slug: string;
  subsection: string | null;
  nodes: CanonicalNode[];
  citation: Citation;
  availableSubsections: string[];
}

export type NoDocsResult = { status: 'no_docs'; fallbacks: Fallback[] };
/**
 * Distinct from `no_docs`: surfaced by the probe-existence path (probe(),
 * listPages()) when CodeWiki has no wiki for the repo at all. Shape is kept
 * deliberately lean — callers that want fallback URLs derive them from the
 * repo string themselves (GitHub README, request_indexing).
 */
export type NoWikiResult = { status: 'no_wiki' };
export type RateLimitedResult = { status: 'rate_limited'; retryAfterSeconds: number };
export type RetryResult = { status: 'retry'; retryAfterSeconds: number; reason: string };
/**
 * F1: getPage was called with a `slug` or `subsection` that does not match
 * any heading slug in the repo's CodeWiki page. Distinct from `no_wiki`
 * (the whole wiki is missing) and `no_docs` (the upstream returned 404
 * mid-flow). Echoes the bad inputs back so the agent can correct, AND
 * surfaces `availableSubsections` so it can pick a valid one. Citation URL
 * anchors to the repo root (no fragment) — the bad slug must NEVER end up
 * in the citation URL.
 */
export type NoMatchResult = {
  status: 'no_match';
  repo: string;
  slug: string;
  subsection: string | null;
  availableSubsections: string[];
  citation: Citation;
  reason: string;
};

export type ListPagesResult =
  | { repo: string; pageIndex: PageIndexEntry[] }
  | { repo: string; status: 'no_wiki'; pageIndex: [] };

export class CodeWikiClient {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private nextAllowedAt = 0;

  constructor(
    private readonly driver: PlaywrightDriver,
    private readonly cache: Cache,
  ) {}

  /**
   * Test seam: replace the page-fetch step. Default uses playwright_driver
   * to navigate + extract. Tests substitute a stub returning canned data.
   */
  fetchPage: (repo: string) => Promise<ExtractionResult> = (repo) => this.defaultFetchPage(repo);

  // -------------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------------

  async probe(repo: string): Promise<ProbeResult | NoWikiResult> {
    const key = `probe::${repo}`;
    return this.singleFlight(key, async () => {
      const cached = this.cache.getWikiStatus(repo);
      if (cached && Date.now() - cached.checkedAt < WIKI_STATUS_TTL_MS) {
        if (!cached.hasWiki) return { status: 'no_wiki' } as NoWikiResult;
        return {
          hasWiki: true,
          pageCount: cached.pageCount,
          pageIndex: cached.pageIndex as PageIndexEntry[],
        };
      }

      const result = await this.fetchPage(repo);
      if (result.notFound) {
        // 404-or-empty-toc short circuit (anchored on stable <app-not-found>
        // selector inside extractFromDocument). Cache as hasWiki=false so
        // subsequent calls short-circuit without a fetch.
        this.cache.setWikiStatus(repo, false, 0, []);
        return { status: 'no_wiki' } as NoWikiResult;
      }
      if (result.emptyShell) {
        // Codex finding: empty SPA shell is transient (bot challenge / DOM
        // drift). Throw rate_limited so the caller backs off instead of
        // caching this as no-wiki for 24h.
        throw new CodeWikiError('rate_limited', 'CodeWiki returned an empty SPA shell — possible bot challenge or DOM change', 60);
      }
      const pageIndex = buildPageIndex(result.nodes);
      this.cache.setWikiStatus(repo, true, pageIndex.length, pageIndex);
      return { hasWiki: true, pageCount: pageIndex.length, pageIndex };
    }) as Promise<ProbeResult | NoWikiResult>;
  }

  // -------------------------------------------------------------------------
  // listPages
  // -------------------------------------------------------------------------

  async listPages(repo: string): Promise<ListPagesResult> {
    const r = await this.probe(repo);
    if ('status' in r) return { repo, status: 'no_wiki', pageIndex: [] };
    return { repo, pageIndex: r.pageIndex };
  }

  // -------------------------------------------------------------------------
  // getPage
  // -------------------------------------------------------------------------

  async getPage(
    repo: string,
    slug?: string,
    subsection?: string,
  ): Promise<PageResult | NoDocsResult | RateLimitedResult | RetryResult | NoMatchResult> {
    // `slug` addresses a top-level page within a multi-page CodeWiki entry;
    // when omitted, defaults to '__root__' (the index/overview document).
    // `subsection` is a deeper heading slug within that page.
    const pageSlug = slug ?? '__root__';
    const key = `getPage::${repo}::${pageSlug}::${subsection ?? ''}`;
    return this.singleFlight(key, async () => {
      const cached = this.cache.getPage(repo, pageSlug);
      const now = Date.now();

      let nodes: CanonicalNode[] | null = null;
      let commitSha: string | null = null;

      if (cached) {
        const fresh = now - cached.fetchedAt < PAGE_TTL_MS;
        if (fresh) {
          nodes = cached.body as CanonicalNode[];
          commitSha = cached.commitSha;
        } else {
          // TTL expired — SHA-only probe.
          let upstream: ExtractionResult;
          try {
            upstream = await this.fetchPage(repo);
          } catch (err) {
            return this.errorToStatus(err) ?? rethrowOrNull(err);
          }
          if (upstream.notFound) {
            this.cache.setWikiStatus(repo, false, 0, []);
            this.cache.invalidatePage(repo, pageSlug);
            return { status: 'no_docs', fallbacks: buildFallbacks(repo) } as NoDocsResult;
          }
          if (upstream.firstCommitSha === cached.commitSha) {
            this.cache.refreshPageTimestamp(repo, pageSlug);
            nodes = cached.body as CanonicalNode[];
            commitSha = cached.commitSha;
          } else {
            nodes = upstream.nodes;
            commitSha = upstream.firstCommitSha ?? cached.commitSha;
            this.cache.setPage(repo, pageSlug, nodes, commitSha);
          }
        }
      } else {
        // Cache miss.
        let upstream: ExtractionResult;
        try {
          upstream = await this.fetchPage(repo);
        } catch (err) {
          return this.errorToStatus(err) ?? rethrowOrNull(err);
        }
        if (upstream.notFound) {
          this.cache.setWikiStatus(repo, false, 0, []);
          return { status: 'no_docs', fallbacks: buildFallbacks(repo) } as NoDocsResult;
        }
        nodes = upstream.nodes;
        commitSha = upstream.firstCommitSha ?? '';
        this.cache.setPage(repo, pageSlug, nodes, commitSha);
      }

      // F1: Heading-set validation BEFORE any citation/serialization work.
      // CodeWiki is single-page-per-repo (line ~245: const url = base + repo),
      // so both `slug` (top-level page slug = heading anchor) and `subsection`
      // (deeper heading slug) must resolve to a heading that actually exists
      // in the extracted canonical tree. If either is provided but unknown,
      // emit the no_match envelope instead of smuggling root content under a
      // fragment that anchors to nothing.
      const allSubsections = nodes
        .filter((n): n is HeadingNode => n.type === 'heading')
        .map((h) => h.slug);
      const slugMissing = pageSlug !== '__root__' && !allSubsections.includes(pageSlug);
      const subsectionMissing = subsection != null && !allSubsections.includes(subsection);
      if (slugMissing || subsectionMissing) {
        return {
          status: 'no_match',
          repo,
          slug: pageSlug,
          subsection: subsection ?? null,
          availableSubsections: allSubsections,
          citation: {
            sourceUrl: `${CODEWIKI_BASE_URL}${repo}`,
            commitSha: commitSha ?? '',
            lastChecked: new Date().toISOString(),
          },
          reason: 'requested slug/subsection not found in this CodeWiki page',
        };
      }

      // Optional sub-section drilldown.
      let returnedNodes = nodes;
      let returnedSubsection: string | null = null;
      if (subsection) {
        returnedNodes = subtreeFor(nodes, subsection);
        returnedSubsection = subsection;
      }

      const anchor = subsection ?? (pageSlug !== '__root__' ? pageSlug : null);
      const sourceUrl = `${CODEWIKI_BASE_URL}${repo}${anchor ? '#' + anchor : ''}`;
      const citation: Citation = {
        sourceUrl,
        commitSha: commitSha ?? '',
        lastChecked: new Date().toISOString(),
      };

      return {
        repo,
        slug: pageSlug,
        subsection: returnedSubsection,
        nodes: returnedNodes,
        citation,
        availableSubsections: allSubsections,
      };
    }) as Promise<PageResult | NoDocsResult | RateLimitedResult | RetryResult>;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const p = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  private async defaultFetchPage(repo: string): Promise<ExtractionResult> {
    await this.respectRateLimit();
    const url = `${CODEWIKI_BASE_URL}${repo}`;
    try {
      return await this.driver.withPage(async (page: Page) => {
        try {
          await page.goto(url, { waitUntil: 'networkidle' });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new CodeWikiError('upstream_unavailable', `failed to load ${url}: ${msg}`);
        }
        const result = await extractFromPage(page);
        // Empty-shell vs explicit not-found is now distinguished by the
        // extractor itself. We pass both through; callers (probe / getPage)
        // map emptyShell to rate_limited and notFound to no_docs.
        return result;
      });
    } catch (err) {
      // RC2 (MCP -32000 fix): the Playwright install promise is still
      // pending or has rejected. Surface as a structured `rate_limited`
      // envelope (retryAfterSeconds = err.retryAfterSeconds ?? 30) so the
      // existing tool surface ALREADY handles the case — clients see a
      // retry hint, not a thrown exception.
      if (err instanceof PlaywrightUnavailableError) {
        throw new CodeWikiError(
          'rate_limited',
          `Playwright is not yet available: ${err.message}`,
          err.retryAfterSeconds ?? 30,
        );
      }
      throw err;
    }
  }

  private async respectRateLimit(): Promise<void> {
    const now = Date.now();
    if (now < this.nextAllowedAt) {
      await new Promise((r) => setTimeout(r, this.nextAllowedAt - now));
    }
    this.nextAllowedAt = Date.now() + RATE_LIMIT_INTERVAL_MS;
  }

  private errorToStatus(err: unknown): NoDocsResult | RateLimitedResult | RetryResult | null {
    if (err instanceof CodeWikiError) {
      if (err.kind === 'rate_limited') {
        return { status: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds ?? 60 };
      }
      if (err.kind === 'no_docs') {
        return { status: 'no_docs', fallbacks: [] };
      }
      // Transient network or DOM issues — surface as retry, NEVER as a thrown
      // exception (Failure UX rule: only true exceptions get isError:true).
      if (err.kind === 'upstream_unavailable' || err.kind === 'codewiki_dom_changed') {
        return { status: 'retry', retryAfterSeconds: err.retryAfterSeconds ?? 30, reason: err.message };
      }
    }
    return null;
  }
}

function rethrowOrNull(err: unknown): never {
  throw err instanceof Error ? err : new Error(String(err));
}

function buildFallbacks(repo: string): Fallback[] {
  return [
    { kind: 'github_readme', url: `https://github.com/${repo}#readme`, label: 'README on GitHub' },
    { kind: 'request_indexing', url: `${CODEWIKI_BASE_URL}${repo}`, label: 'Request CodeWiki indexing' },
  ];
}

function buildPageIndex(nodes: CanonicalNode[]): PageIndexEntry[] {
  const out: PageIndexEntry[] = [];
  for (const n of nodes) {
    if (n.type !== 'heading') continue;
    out.push({
      slug: n.slug,
      title: n.title,
      level: n.level,
      parentSlug: n.parentSlug,
      hasDiagrams: n.hasDiagrams,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: CodeWikiClient | null = null;

export async function getCodeWikiClient(): Promise<CodeWikiClient> {
  if (!_instance) {
    const cache = await Cache.open();
    _instance = new CodeWikiClient(getPlaywrightDriver(), cache);
  }
  return _instance;
}
