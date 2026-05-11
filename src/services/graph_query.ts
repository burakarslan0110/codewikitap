/**
 * GraphQuery — typed facade over the kg_edges store. Maps the four user-
 * facing query kinds to graphStore.findEdges(...) plus a query-time
 * dep_link derivation from the project scan + wiki_index_status.
 *
 * For repo-bound queries, the GraphQuery races `Indexer.indexRepo(repo)`
 * against `INDEX_BUILD_TIMEOUT_MS` so the first call surfaces
 * `status: 'index_building'` instead of blocking. The race only triggers
 * when the repo isn't already in `vectorStore.listIndexedRepos()`.
 */

import { CODEWIKI_BASE_URL } from '../config.js';
import { INDEX_BUILD_TIMEOUT_MS } from '../config_rag.js';
import type { Cache } from './cache.js';
import type { GraphStore } from './graph_store.js';
import type { VectorStore } from './vector_store.js';
import type { Indexer, IndexerResult } from './indexer.js';
import type { Embedder } from '../adapters/embedder.js';
import { EmbedderError } from '../types.js';
import type {
  Citation,
  KgEdge,
  KgEdgeType,
  KgNodeKind,
  ProjectScan,
} from '../types.js';

export interface KgNeighbor {
  kind: KgNodeKind;
  id: string;
  label?: string;
  edge_type: KgEdgeType | 'dep_link';
  direction: 'in' | 'out';
  repo?: string;
  citation?: Citation;
  metadata?: Record<string, unknown>;
  /**
   * v2.5: cosine similarity in [0, 1] between the query and the
   * destination section's chunk text. Present iff the call passed `query`.
   * Absent on no-query calls (the v2.4 invariant) and on file/repo
   * neighbors (which have no chunk text to embed).
   */
  score?: number;
}

export interface GraphQueryResult {
  neighbors: KgNeighbor[];
  truncated: boolean;
  status?: 'no_docs' | 'rate_limited' | 'retry' | 'index_building';
  retryAfterSeconds?: number;
  reason?: string;
}

export interface GraphQueryDeps {
  graphStore: GraphStore;
  vectorStore: VectorStore;
  cache: Cache;
  indexer: Pick<Indexer, 'indexRepo'>;
  /**
   * v2.5: optional embedder for the find_neighbors `query` semantic-rank
   * branch. Lazy-injected — sessions that never pass `query` never load
   * the model (preserves the v2.1 KG-only divergence invariant).
   */
  embedder?: Embedder;
}

export interface PagesReferencingFileOpts {
  filePath: string;
  githubRepo?: string;
  limit?: number;
  timeoutMs?: number;
  /** v2.5: optional natural-language query for semantic re-rank. */
  query?: string;
}

export interface DiagramNeighborsOpts {
  repo: string;
  sectionSlug: string;
  diagramNodeId?: string;
  limit?: number;
  timeoutMs?: number;
  /** v2.5: optional natural-language query for semantic re-rank. */
  query?: string;
}

export interface SectionLinksOpts {
  repo: string;
  sectionSlug: string;
  direction?: 'in' | 'out' | 'both';
  limit?: number;
  timeoutMs?: number;
  /** v2.5: optional natural-language query for semantic re-rank. */
  query?: string;
}

export interface CrossRepoOpts {
  repo: string;
  direction?: 'in' | 'out' | 'both';
  limit?: number;
  timeoutMs?: number;
  getProjectDeps?: () => ProjectScan;
  /** v2.5: optional natural-language query for semantic re-rank. */
  query?: string;
}

const DEFAULT_LIMIT = 16;

export class GraphQuery {
  constructor(private readonly deps: GraphQueryDeps) {}

  // -------------------------------------------------------------------------
  // pages_referencing_file
  // -------------------------------------------------------------------------

  async pagesReferencingFile(opts: PagesReferencingFileOpts): Promise<GraphQueryResult> {
    const limit = opts.limit ?? DEFAULT_LIMIT;

    // pages_referencing_file does NOT index the target repo: `github_repo` is
    // a filter on the file's GitHub OWNER, not the repo that documented it.
    // The OWNING repo (the repo whose section references the file) can be
    // anything in `wiki_index_status`; forcing an index of `github_repo`
    // would block the lookup on a wiki the user may not even be querying.

    const dstId = opts.githubRepo ? `${opts.githubRepo}:${opts.filePath}` : null;
    const edges = dstId
      ? this.deps.graphStore.findEdges({
          dst: { kind: 'file', id: dstId },
          edgeType: 'code_ref',
        })
      : this.deps.graphStore.findEdgesByFilePath(opts.filePath);

    if (
      edges.length === 0 &&
      !opts.githubRepo &&
      this.deps.vectorStore.listIndexedRepos().length === 0
    ) {
      // No edges AND no repos indexed → tell the agent to index something
      // first instead of returning a silent empty.
      return {
        neighbors: [],
        truncated: false,
        status: 'no_docs',
        reason: 'no_indexed_repos',
      };
    }

    const neighbors = edges.map((e) => this.toSectionNeighborFromCodeRef(e));
    return this.finalizeWithRank(neighbors, limit, opts.query);
  }

  // -------------------------------------------------------------------------
  // section_links
  // -------------------------------------------------------------------------

  async sectionLinks(opts: SectionLinksOpts): Promise<GraphQueryResult> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const direction = opts.direction ?? 'both';
    const timeoutMs = opts.timeoutMs ?? INDEX_BUILD_TIMEOUT_MS;

    const ensured = await this.ensureIndexed(opts.repo, timeoutMs);
    if (ensured.kind !== 'ok') return ensured.result;

    const sectionId = `${opts.repo}#${opts.sectionSlug}`;
    const neighbors: KgNeighbor[] = [];

    if (direction === 'out' || direction === 'both') {
      const edges = this.deps.graphStore.findEdges({
        src: { kind: 'section', id: sectionId },
        edgeType: 'section_link',
        repo: opts.repo,
      });
      for (const e of edges) {
        neighbors.push(this.toSectionNeighbor(e, 'out', e.dstId));
      }
    }
    if (direction === 'in' || direction === 'both') {
      const edges = this.deps.graphStore.findEdges({
        dst: { kind: 'section', id: sectionId },
        edgeType: 'section_link',
        repo: opts.repo,
      });
      for (const e of edges) {
        neighbors.push(this.toSectionNeighbor(e, 'in', e.srcId));
      }
    }
    return this.finalizeWithRank(neighbors, limit, opts.query);
  }

  // -------------------------------------------------------------------------
  // diagram_neighbors
  // -------------------------------------------------------------------------

  async diagramNeighbors(opts: DiagramNeighborsOpts): Promise<GraphQueryResult> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const timeoutMs = opts.timeoutMs ?? INDEX_BUILD_TIMEOUT_MS;

    const ensured = await this.ensureIndexed(opts.repo, timeoutMs);
    if (ensured.kind !== 'ok') return ensured.result;

    const sectionId = `${opts.repo}#${opts.sectionSlug}`;
    const neighbors: KgNeighbor[] = [];

    if (opts.diagramNodeId) {
      const nodeId = `${opts.repo}#${opts.sectionSlug}::${opts.diagramNodeId}`;
      const outEdges = this.deps.graphStore.findEdges({
        src: { kind: 'diagram_node', id: nodeId },
        edgeType: 'diagram_edge',
        repo: opts.repo,
      });
      for (const e of outEdges) {
        neighbors.push(this.toDiagramNodeNeighbor(e, 'out', e.dstId));
      }
      const inEdges = this.deps.graphStore.findEdges({
        dst: { kind: 'diagram_node', id: nodeId },
        edgeType: 'diagram_edge',
        repo: opts.repo,
      });
      for (const e of inEdges) {
        neighbors.push(this.toDiagramNodeNeighbor(e, 'in', e.srcId));
      }
    } else {
      // Section-only mode: members + structural edges among members.
      const members = this.deps.graphStore.findEdges({
        src: { kind: 'section', id: sectionId },
        edgeType: 'diagram_member',
        repo: opts.repo,
      });
      for (const e of members) {
        neighbors.push(this.toDiagramNodeNeighbor(e, 'out', e.dstId));
      }
      const memberIds = new Set(members.map((e) => e.dstId));
      // Structural edges where both endpoints are in this section's members.
      // We can't filter by membership in SQL; broad scan by repo+type then
      // post-filter. Repo scoping keeps the scan tight.
      const structural = this.deps.graphStore.findEdges({
        repo: opts.repo,
        edgeType: 'diagram_edge',
      });
      for (const e of structural) {
        if (memberIds.has(e.srcId) && memberIds.has(e.dstId)) {
          neighbors.push(this.toDiagramNodeNeighbor(e, 'out', e.dstId, e.srcId));
        }
      }
    }
    return this.finalizeWithRank(neighbors, limit, opts.query);
  }

  // -------------------------------------------------------------------------
  // cross_repo
  // -------------------------------------------------------------------------

  async crossRepo(opts: CrossRepoOpts): Promise<GraphQueryResult> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const direction = opts.direction ?? 'both';
    const timeoutMs = opts.timeoutMs ?? INDEX_BUILD_TIMEOUT_MS;

    const ensured = await this.ensureIndexed(opts.repo, timeoutMs);
    if (ensured.kind !== 'ok') return ensured.result;

    const neighbors: KgNeighbor[] = [];

    if (direction === 'out' || direction === 'both') {
      // Stored cross_repo_ref rows owned by this repo, aggregated by dst.
      const rows = this.deps.graphStore.findEdges({
        repo: opts.repo,
        edgeType: 'cross_repo_ref',
      });
      const byDst = new Map<string, { rows: KgEdge[] }>();
      for (const r of rows) {
        const entry = byDst.get(r.dstId) ?? { rows: [] };
        entry.rows.push(r);
        byDst.set(r.dstId, entry);
      }
      for (const [dst, agg] of byDst) {
        const fromSections = Array.from(
          new Set(agg.rows.map((r) => stripRepoPrefix(r.srcId, opts.repo))),
        );
        const kinds = new Set<string>();
        for (const r of agg.rows) {
          const k = (r.metadata?.kinds as string[] | undefined) ?? [];
          for (const x of k) kinds.add(x);
        }
        neighbors.push({
          kind: 'repo',
          id: dst,
          edge_type: 'cross_repo_ref',
          direction: 'out',
          repo: dst,
          citation: this.buildRepoCitation(dst, agg.rows[0].commitSha),
          metadata: {
            from_sections: fromSections,
            ...(kinds.size > 0 ? { kinds: Array.from(kinds).sort() } : {}),
          },
        });
      }
    }

    if (direction === 'in' || direction === 'both') {
      // Rows whose dst_id IS this repo, grouped by owning repo (the source).
      const rows = this.deps.graphStore.findEdges({
        dst: { kind: 'repo', id: opts.repo },
        edgeType: 'cross_repo_ref',
      });
      const bySrcRepo = new Map<string, { rows: KgEdge[] }>();
      for (const r of rows) {
        const entry = bySrcRepo.get(r.repo) ?? { rows: [] };
        entry.rows.push(r);
        bySrcRepo.set(r.repo, entry);
      }
      for (const [srcRepo, agg] of bySrcRepo) {
        const fromSections = Array.from(
          new Set(agg.rows.map((r) => stripRepoPrefix(r.srcId, srcRepo))),
        );
        neighbors.push({
          kind: 'repo',
          id: srcRepo,
          edge_type: 'cross_repo_ref',
          direction: 'in',
          repo: srcRepo,
          citation: this.buildRepoCitation(srcRepo, agg.rows[0].commitSha),
          metadata: { from_sections: fromSections },
        });
      }
    }

    // dep_link derivation (only when getProjectDeps provided).
    if (opts.getProjectDeps) {
      const scan = opts.getProjectDeps();
      const indexedRepos = new Set(this.deps.vectorStore.listIndexedRepos());
      for (const dep of scan.dependencies) {
        const cached = this.deps.cache.getRepo(dep.name, dep.ecosystem);
        if (!cached) continue;
        const depRepo = `${cached.owner}/${cached.repo}`;
        if (depRepo === opts.repo) continue;
        if (!indexedRepos.has(depRepo)) continue;
        if (direction === 'out' || direction === 'both') {
          neighbors.push({
            kind: 'repo',
            id: depRepo,
            edge_type: 'dep_link',
            direction: 'out',
            repo: depRepo,
            citation: this.buildRepoCitation(depRepo, ''),
            metadata: { derivation: 'project_scan', dep_name: dep.name, ecosystem: dep.ecosystem },
          });
        }
      }
    }

    return this.finalizeWithRank(neighbors, limit, opts.query);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * v2.5: optionally re-rank neighbors by cosine similarity to `query`
   * before finalize. When `query` is undefined, behaves identically to
   * `finalize(neighbors, limit)` — preserving the v2.1 KG-only invariant
   * (no embedder load on the no-query path).
   */
  private async finalizeWithRank(
    neighbors: KgNeighbor[],
    limit: number,
    query: string | undefined,
  ): Promise<GraphQueryResult> {
    if (!query || !this.deps.embedder) {
      return finalize(neighbors, limit);
    }
    const ranked = await applySemanticRank(neighbors, query, this.deps.embedder, this.deps.vectorStore);
    if (ranked.kind === 'retry') return ranked.result;
    return finalize(ranked.neighbors, limit);
  }

  private async ensureIndexed(
    repo: string,
    timeoutMs: number,
  ): Promise<{ kind: 'ok' } | { kind: 'status'; result: GraphQueryResult }> {
    // Lifecycle invariant (Codex finding): the repo is GRAPH-ready only when
    // wiki_index_status exists AND its edge_count is non-negative. The -1
    // sentinel means "graph never built" — either a v2-shape row that
    // pre-dates the column, or a `{ buildGraph: false }` test seam call.
    // Treat both as "not graph-ready" and trigger indexer.indexRepo, which
    // sees the same sentinel and runs a full rebuild (defense-in-depth at
    // src/services/indexer.ts ≈ line 100).
    //
    // We deliberately do NOT compare status.edgeCount to the live row count
    // in kg_edges — the atomic write transaction binds them together, so
    // drift is a non-condition in production, and tests directly seed edges
    // without going through the indexer.
    const status = this.deps.vectorStore.getWikiIndexStatus(repo);
    const graphReady = status !== null && status.edgeCount >= 0;
    if (graphReady) {
      return { kind: 'ok' };
    }
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), timeoutMs);
    });
    const indexPromise = this.deps.indexer.indexRepo(repo);
    let raced: IndexerResult | '__timeout__';
    try {
      raced = await Promise.race([indexPromise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (raced === '__timeout__') {
      // The indexer continues in the background under its single-flight.
      return {
        kind: 'status',
        result: { neighbors: [], truncated: false, status: 'index_building' },
      };
    }
    if (raced.status === 'no_docs') {
      return { kind: 'status', result: { neighbors: [], truncated: false, status: 'no_docs' } };
    }
    if (raced.status === 'rate_limited') {
      return {
        kind: 'status',
        result: {
          neighbors: [],
          truncated: false,
          status: 'rate_limited',
          retryAfterSeconds: raced.retryAfterSeconds,
        },
      };
    }
    if (raced.status === 'retry') {
      return {
        kind: 'status',
        result: {
          neighbors: [],
          truncated: false,
          status: 'retry',
          retryAfterSeconds: raced.retryAfterSeconds,
          reason: raced.reason,
        },
      };
    }
    return { kind: 'ok' };
  }

  private toSectionNeighborFromCodeRef(e: KgEdge): KgNeighbor {
    const sectionRepo = e.repo;
    return {
      kind: 'section',
      id: e.srcId,
      edge_type: 'code_ref',
      direction: 'in', // querying by file → returning the section that points at it = inbound from the file's perspective
      repo: sectionRepo,
      citation: this.buildSectionCitation(sectionRepo, stripRepoPrefix(e.srcId, sectionRepo), e.commitSha),
      metadata: e.metadata,
    };
  }

  private toSectionNeighbor(e: KgEdge, direction: 'in' | 'out', neighborId: string): KgNeighbor {
    const sectionSlug = stripRepoPrefix(neighborId, e.repo);
    return {
      kind: 'section',
      id: neighborId,
      edge_type: e.edgeType,
      direction,
      repo: e.repo,
      citation: this.buildSectionCitation(e.repo, sectionSlug, e.commitSha),
      metadata: e.metadata,
    };
  }

  private toDiagramNodeNeighbor(
    e: KgEdge,
    direction: 'in' | 'out',
    neighborId: string,
    sourceOverride?: string,
  ): KgNeighbor {
    const sectionSlug = sectionSlugFromDiagramNodeId(neighborId);
    return {
      kind: 'diagram_node',
      id: neighborId,
      label: (e.metadata?.label as string | undefined) ?? undefined,
      edge_type: e.edgeType,
      direction,
      repo: e.repo,
      citation: sectionSlug
        ? this.buildSectionCitation(e.repo, sectionSlug, e.commitSha)
        : undefined,
      metadata: sourceOverride
        ? { ...e.metadata, source_node_id: sourceOverride }
        : e.metadata,
    };
  }

  private buildSectionCitation(repo: string, sectionSlug: string, commitSha: string): Citation {
    return {
      sourceUrl: `${CODEWIKI_BASE_URL}${repo}#${sectionSlug}`,
      commitSha,
      lastChecked: new Date().toISOString(),
    };
  }

  private buildRepoCitation(repo: string, fallbackSha: string): Citation {
    const status = this.deps.vectorStore.getWikiIndexStatus(repo);
    return {
      sourceUrl: `${CODEWIKI_BASE_URL}${repo}`,
      commitSha: status?.commitSha ?? fallbackSha,
      lastChecked: new Date().toISOString(),
    };
  }
}

function finalize(neighbors: KgNeighbor[], limit: number): GraphQueryResult {
  const truncated = neighbors.length > limit;
  return {
    neighbors: truncated ? neighbors.slice(0, limit) : neighbors,
    truncated,
  };
}

/**
 * v2.5: cosine similarity for L2-normalized vectors. Re-uses the same
 * inner product the vector store uses for find_chunks ranking.
 */
function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * v2.5: re-rank neighbors by cosine similarity between the query and the
 * destination section's chunk text. Only `section` and `diagram_node`
 * neighbors are scored; `file` and `repo` neighbors stay in v2.4 order at
 * the bottom (they have no chunk text to embed). Per-call encoding cache
 * collapses identical sections (critical for `direction='both'` queries
 * that often surface overlapping sections).
 *
 * EmbedderError translates to `status: 'retry'` (mirrors find_chunks UX
 * — the failure-mode contract documented in `codewiki-mcp-rag.md`).
 *
 * Returns the re-ranked neighbors OR a `GraphQueryResult` with `status`
 * set when the embedder fails — caller should propagate that result
 * directly without finalize().
 */
async function applySemanticRank(
  neighbors: KgNeighbor[],
  query: string,
  embedder: Embedder,
  vectorStore: VectorStore,
): Promise<{ kind: 'ok'; neighbors: KgNeighbor[] } | { kind: 'retry'; result: GraphQueryResult }> {
  let queryVec: Float32Array;
  try {
    [queryVec] = await embedder.encode([query]);
  } catch (err) {
    if (err instanceof EmbedderError) {
      return {
        kind: 'retry',
        result: {
          neighbors: [],
          truncated: false,
          status: 'retry',
          retryAfterSeconds: 60,
          reason: `embedder ${err.kind}: ${err.message}`,
        },
      };
    }
    throw err;
  }

  // Per-call encoding cache: collapses identical (repo, sectionSlug) pairs.
  const sectionCache = new Map<string, Float32Array | null>();
  const encodeSection = async (repo: string, sectionSlug: string): Promise<Float32Array | null> => {
    const cacheKey = `${repo}#${sectionSlug}`;
    if (sectionCache.has(cacheKey)) return sectionCache.get(cacheKey) ?? null;
    const texts = vectorStore.fetchChunkTextsForSection(repo, sectionSlug);
    if (texts.length === 0) {
      sectionCache.set(cacheKey, null);
      return null;
    }
    try {
      const [vec] = await embedder.encode([texts.join('\n\n')]);
      sectionCache.set(cacheKey, vec);
      return vec;
    } catch (err) {
      if (err instanceof EmbedderError) throw err;
      sectionCache.set(cacheKey, null);
      return null;
    }
  };

  // Score sectionable neighbors; carry repo/file at the bottom.
  const sectionable: Array<{ neighbor: KgNeighbor; score: number }> = [];
  const tail: KgNeighbor[] = [];
  for (const n of neighbors) {
    let repo: string | undefined;
    let sectionSlug: string | undefined;
    if (n.kind === 'section') {
      repo = n.repo;
      sectionSlug = repo ? stripRepoPrefix(n.id, repo) : undefined;
    } else if (n.kind === 'diagram_node') {
      repo = n.repo;
      sectionSlug = sectionSlugFromDiagramNodeId(n.id) ?? undefined;
    } else {
      tail.push(n);
      continue;
    }
    if (!repo || !sectionSlug) {
      tail.push(n);
      continue;
    }
    let vec: Float32Array | null;
    try {
      vec = await encodeSection(repo, sectionSlug);
    } catch (err) {
      if (err instanceof EmbedderError) {
        return {
          kind: 'retry',
          result: {
            neighbors: [],
            truncated: false,
            status: 'retry',
            retryAfterSeconds: 60,
            reason: `embedder ${err.kind}: ${err.message}`,
          },
        };
      }
      throw err;
    }
    if (!vec) {
      tail.push(n);
      continue;
    }
    sectionable.push({ neighbor: { ...n, score: cosineSim(queryVec, vec) }, score: cosineSim(queryVec, vec) });
  }

  sectionable.sort((a, b) => b.score - a.score);
  return {
    kind: 'ok',
    neighbors: [...sectionable.map((s) => s.neighbor), ...tail],
  };
}

function stripRepoPrefix(id: string, repo: string): string {
  const prefix = `${repo}#`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function sectionSlugFromDiagramNodeId(diagramNodeId: string): string | null {
  // Format: <owner>/<repo>#<sectionSlug>::<nodeId>
  const hash = diagramNodeId.indexOf('#');
  const sep = diagramNodeId.indexOf('::');
  if (hash === -1 || sep === -1 || sep < hash) return null;
  return diagramNodeId.slice(hash + 1, sep);
}
