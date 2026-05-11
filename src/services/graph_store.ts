/**
 * GraphStore — wraps the kg_edges table behind a typed API.
 *
 * Both native (better-sqlite3) and in-memory backends are supported via the
 * existing SqliteStore interface. Sort + limit are always applied JS-side
 * because the in-memory parser does not support ORDER BY / LIMIT.
 *
 * SHA-agnostic file path lookup (`findEdgesByFilePath`) reads broadly by
 * (dst_kind='file', edge_type='code_ref') and post-filters by
 * `dstId.endsWith(':' + filePath)` — same code path on both backends.
 */

import type { Cache } from './cache.js';
import type { KgEdge, KgEdgeType, KgNodeRef } from '../types.js';

export interface FindEdgesOptions {
  src?: KgNodeRef;
  dst?: KgNodeRef;
  edgeType?: KgEdgeType;
  repo?: string;
  limit?: number;
}

export class GraphStore {
  constructor(private readonly cache: Cache) {}

  upsertEdges(edges: KgEdge[]): void {
    if (edges.length === 0) return;
    const store = this.cache.getStore();
    const stmt = store.prepare(
      'INSERT OR REPLACE INTO kg_edges (src_kind, src_id, dst_kind, dst_id, edge_type, repo, metadata, commit_sha, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const e of edges) {
      stmt.run(
        e.srcKind,
        e.srcId,
        e.dstKind,
        e.dstId,
        e.edgeType,
        e.repo,
        e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
        e.commitSha,
        e.indexedAt,
      );
    }
  }

  findEdges(opts: FindEdgesOptions): KgEdge[] {
    if (!opts.src && !opts.dst && !opts.repo) {
      throw new Error('graph_store: findEdges requires at least one of {src, dst, repo}');
    }
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts.src) {
      conditions.push('src_kind = ?');
      params.push(opts.src.kind);
      conditions.push('src_id = ?');
      params.push(opts.src.id);
    }
    if (opts.dst) {
      conditions.push('dst_kind = ?');
      params.push(opts.dst.kind);
      conditions.push('dst_id = ?');
      params.push(opts.dst.id);
    }
    if (opts.repo) {
      conditions.push('repo = ?');
      params.push(opts.repo);
    }
    if (opts.edgeType) {
      conditions.push('edge_type = ?');
      params.push(opts.edgeType);
    }
    const sql = `SELECT src_kind, src_id, dst_kind, dst_id, edge_type, repo, metadata, commit_sha, indexed_at FROM kg_edges WHERE ${conditions.join(' AND ')}`;
    const rows = this.cache.getStore().prepare(sql).all(...params);
    const sorted = this.toEdges(rows).sort(compareEdgesDesc);
    return opts.limit !== undefined ? sorted.slice(0, opts.limit) : sorted;
  }

  /**
   * SHA-agnostic file lookup. Returns every code_ref whose `dstId` ends
   * with `:<filePath>` regardless of the owning github repo.
   *
   * The native path could use `LIKE '%:<path>'` but the in-memory store
   * does not support `LIKE`; running a broad scan + JS post-filter is
   * the same code path on both backends and stays under 1 ms at v2.1's
   * scale (≤ 50 k chunks per cache file).
   */
  findEdgesByFilePath(filePath: string, limit?: number): KgEdge[] {
    const sql =
      'SELECT src_kind, src_id, dst_kind, dst_id, edge_type, repo, metadata, commit_sha, indexed_at FROM kg_edges WHERE dst_kind = ? AND edge_type = ?';
    const rows = this.cache.getStore().prepare(sql).all('file', 'code_ref');
    const suffix = `:${filePath}`;
    const filtered = this.toEdges(rows).filter((e) => e.dstId.endsWith(suffix));
    const sorted = filtered.sort(compareEdgesDesc);
    return limit !== undefined ? sorted.slice(0, limit) : sorted;
  }

  dropForRepo(repo: string): void {
    this.cache.getStore().prepare('DELETE FROM kg_edges WHERE repo = ?').run(repo);
  }

  edgeCountForRepo(repo: string): number {
    const rows = this.cache
      .getStore()
      .prepare('SELECT src_id FROM kg_edges WHERE repo = ?')
      .all(repo);
    return rows.length;
  }

  private toEdges(rows: Array<Record<string, unknown>>): KgEdge[] {
    return rows.map((r) => {
      const edge: KgEdge = {
        srcKind: String(r.src_kind) as KgEdge['srcKind'],
        srcId: String(r.src_id),
        dstKind: String(r.dst_kind) as KgEdge['dstKind'],
        dstId: String(r.dst_id),
        edgeType: String(r.edge_type) as KgEdge['edgeType'],
        repo: String(r.repo),
        commitSha: r.commit_sha != null ? String(r.commit_sha) : '',
        indexedAt: Number(r.indexed_at),
      };
      if (r.metadata != null) {
        try {
          edge.metadata = JSON.parse(String(r.metadata)) as Record<string, unknown>;
        } catch {
          /* malformed metadata — drop it rather than throw */
        }
      }
      return edge;
    });
  }
}

/** Sort: indexed_at desc, then dst_id asc. Deterministic across backends. */
function compareEdgesDesc(a: KgEdge, b: KgEdge): number {
  if (a.indexedAt !== b.indexedAt) return b.indexedAt - a.indexedAt;
  if (a.dstId < b.dstId) return -1;
  if (a.dstId > b.dstId) return 1;
  return 0;
}
