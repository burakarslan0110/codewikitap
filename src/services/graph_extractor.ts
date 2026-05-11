/**
 * Graph extractor — pure function over CanonicalNode[] producing KgEdge[].
 *
 * Walks the canonical tree once and emits typed edges:
 *   - code_ref         section → file (when CodeNode.github is set)
 *   - cross_repo_ref   section → repo (when a code-block link or anchor URL
 *                      points at a different owner/repo)
 *   - diagram_member   section → diagram_node (per node in DiagramNode.nodes)
 *   - diagram_edge     diagram_node → diagram_node (per edge in DiagramNode.edges)
 *   - section_link     section → section (intra-page anchor links in
 *                      ProseNode.markdown)
 *
 * Determinism: the returned edges are sorted by their PK string so the
 * function is byte-stable for byte-stable input — the snapshot test depends
 * on this, and so does any future cache invalidation that compares old vs
 * new edge sets.
 *
 * commitSha and indexedAt are populated by the Indexer when it persists the
 * edges; this extractor leaves them as `''` and `0`.
 */

import type {
  CanonicalNode,
  CodeNode,
  DiagramNode,
  HeadingNode,
  ProseNode,
} from '../extraction/canonical_tree.js';
import type { KgEdge } from '../types.js';
import { getLogger } from '../logging.js';

const LINK_RE = /\[([^\]]+)\]\((#[^)]+|https:\/\/codewiki\.google\/github\.com\/[^)]+)\)/g;
const CODEWIKI_URL_RE = /^https:\/\/codewiki\.google\/github\.com\/([^/]+)\/([^/#?]+)(?:#(.+))?$/;

// v2.8: prose-level github.com/blob/<sha>/<path>(?[query])?(#L<n>(-L<m>)?)? URLs
// inside ProseNode.markdown. Captured at the graph_extractor layer (not promoted
// to CodeNode) so the canonical-tree contract stays unchanged.
//
// Groups: 1=text, 2=full URL (unused), 3=owner, 4=repo, 5=sha (40-hex),
//         6=path (excludes whitespace, ')', '#', '?'), 7=optional lineRange.
const PROSE_GITHUB_RE =
  /\[([^\]]+)\]\((https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]{40})\/([^\s)#?]+)(?:\?[^)#]*)?(?:#(L\d+(?:-L\d+)?))?)\)/g;

function pkKey(e: Pick<KgEdge, 'srcKind' | 'srcId' | 'dstKind' | 'dstId' | 'edgeType' | 'repo'>): string {
  return [e.srcKind, e.srcId, e.dstKind, e.dstId, e.edgeType, e.repo].join('::');
}

function parseCodeWikiUrl(url: string): { owner: string; repoName: string; anchor?: string } | null {
  const m = CODEWIKI_URL_RE.exec(url);
  if (!m) return null;
  return { owner: m[1], repoName: m[2], anchor: m[3] };
}

export function extractEdges(repo: string, nodes: CanonicalNode[]): KgEdge[] {
  const log = getLogger();
  const edges = new Map<string, KgEdge>();

  function add(e: Omit<KgEdge, 'commitSha' | 'indexedAt'>): void {
    const key = pkKey(e);
    const existing = edges.get(key);
    if (existing) {
      const existingKinds = (existing.metadata?.kinds as string[] | undefined) ?? [];
      const newKinds = (e.metadata?.kinds as string[] | undefined) ?? [];
      const mergedKinds = Array.from(new Set([...existingKinds, ...newKinds])).sort();
      existing.metadata = {
        ...existing.metadata,
        ...e.metadata,
        ...(mergedKinds.length > 0 ? { kinds: mergedKinds } : {}),
      };
      return;
    }
    edges.set(key, { ...e, commitSha: '', indexedAt: 0 });
  }

  function handleCodeNode(n: CodeNode, section: HeadingNode): void {
    if (!n.github) return;
    const { repo: linkRepo, sha, path: filePath, lineRange } = n.github;
    add({
      srcKind: 'section',
      srcId: `${repo}#${section.slug}`,
      dstKind: 'file',
      dstId: `${linkRepo}:${filePath}`,
      edgeType: 'code_ref',
      repo,
      metadata: { sha, ...(lineRange ? { lineRange } : {}) },
    });
    if (linkRepo !== repo) {
      add({
        srcKind: 'section',
        srcId: `${repo}#${section.slug}`,
        dstKind: 'repo',
        dstId: linkRepo,
        edgeType: 'cross_repo_ref',
        repo,
        metadata: { kinds: ['code_block'], file_path: filePath, sha },
      });
    }
  }

  function handleDiagramNode(n: DiagramNode, section: HeadingNode): void {
    const validIds = new Set<string>();
    for (const dn of n.nodes) {
      if (dn.id.includes('::')) {
        log.warn('graph_extractor.diagram_node_id_invalid', {
          nodeId: dn.id,
          repo,
          sectionSlug: section.slug,
        });
        continue;
      }
      validIds.add(dn.id);
      add({
        srcKind: 'section',
        srcId: `${repo}#${section.slug}`,
        dstKind: 'diagram_node',
        dstId: `${repo}#${section.slug}::${dn.id}`,
        edgeType: 'diagram_member',
        repo,
        metadata: { label: dn.label },
      });
    }
    for (const de of n.edges) {
      if (!validIds.has(de.from) || !validIds.has(de.to)) continue;
      add({
        srcKind: 'diagram_node',
        srcId: `${repo}#${section.slug}::${de.from}`,
        dstKind: 'diagram_node',
        dstId: `${repo}#${section.slug}::${de.to}`,
        edgeType: 'diagram_edge',
        repo,
        ...(de.label ? { metadata: { label: de.label } } : {}),
      });
    }
  }

  function handleProseNode(n: ProseNode, section: HeadingNode): void {
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(n.markdown)) !== null) {
      const text = m[1];
      const url = m[2];
      if (url.startsWith('#')) {
        const anchor = url.slice(1);
        if (anchor.length === 0) continue;
        add({
          srcKind: 'section',
          srcId: `${repo}#${section.slug}`,
          dstKind: 'section',
          dstId: `${repo}#${anchor}`,
          edgeType: 'section_link',
          repo,
          metadata: { anchor_text: text },
        });
      } else {
        const parsed = parseCodeWikiUrl(url);
        if (!parsed) continue;
        const { owner, repoName, anchor } = parsed;
        const otherRepo = `${owner}/${repoName}`;
        if (otherRepo === repo) {
          if (!anchor) continue; // self-link to page root — not useful as a section_link
          add({
            srcKind: 'section',
            srcId: `${repo}#${section.slug}`,
            dstKind: 'section',
            dstId: `${repo}#${anchor}`,
            edgeType: 'section_link',
            repo,
            metadata: { anchor_text: text },
          });
        } else {
          add({
            srcKind: 'section',
            srcId: `${repo}#${section.slug}`,
            dstKind: 'repo',
            dstId: otherRepo,
            edgeType: 'cross_repo_ref',
            repo,
            metadata: {
              kinds: ['anchor_link'],
              anchor_text: text,
              ...(anchor ? { anchor } : {}),
            },
          });
        }
      }
    }

    // v2.8: prose-level https://github.com/<owner>/<repo>/blob/<sha>/<path>
    // URLs become code_ref (always) and cross_repo_ref{kinds:[prose_link]}
    // (when the URL's owner/repo differs from the owning repo).
    PROSE_GITHUB_RE.lastIndex = 0;
    while ((m = PROSE_GITHUB_RE.exec(n.markdown)) !== null) {
      const text = m[1];
      const owner = m[3];
      const repoName = m[4];
      const sha = m[5];
      const filePath = m[6];
      const lineRange = m[7];
      const otherRepo = `${owner}/${repoName}`;
      add({
        srcKind: 'section',
        srcId: `${repo}#${section.slug}`,
        dstKind: 'file',
        dstId: `${otherRepo}:${filePath}`,
        edgeType: 'code_ref',
        repo,
        metadata: {
          sha,
          ...(lineRange ? { lineRange } : {}),
          source: 'prose_link',
        },
      });
      if (otherRepo !== repo) {
        add({
          srcKind: 'section',
          srcId: `${repo}#${section.slug}`,
          dstKind: 'repo',
          dstId: otherRepo,
          edgeType: 'cross_repo_ref',
          repo,
          metadata: {
            kinds: ['prose_link'],
            anchor_text: text,
            file_path: filePath,
            sha,
          },
        });
      }
    }
  }

  let currentSection: HeadingNode | null = null;
  for (const node of nodes) {
    if (node.type === 'heading') {
      currentSection = node;
      continue;
    }
    if (!currentSection || node.sectionSlug !== currentSection.slug) {
      // Orphan content (no preceding heading, or sectionSlug mismatch) is
      // ignored — log once at debug-level so we know if drift surfaces.
      log.debug('graph_extractor.orphan_content', {
        repo,
        nodeType: node.type,
        sectionSlug: node.sectionSlug,
      });
      continue;
    }
    if (node.type === 'code') handleCodeNode(node, currentSection);
    else if (node.type === 'diagram') handleDiagramNode(node, currentSection);
    else if (node.type === 'prose') handleProseNode(node, currentSection);
  }

  const result = Array.from(edges.values());
  result.sort((a, b) => {
    const ka = pkKey(a);
    const kb = pkKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  const byType: Record<string, number> = {};
  for (const e of result) byType[e.edgeType] = (byType[e.edgeType] ?? 0) + 1;
  log.debug('graph_extractor.built', { repo, edgeCount: result.length, byType });

  return result;
}
