/**
 * Canonical document tree — the v1 ↔ v2 contract.
 *
 * Every CodeWiki page extraction produces a flat array of CanonicalNode in
 * document order. Each node carries `sectionSlug` so sub-section retrieval
 * can filter by ancestry. The first node of each section is a HeadingNode
 * whose `slug` equals its `sectionSlug`; subsequent content nodes (prose,
 * code, diagram) belong to the same section until the next HeadingNode.
 *
 * v2's RAG indexer consumes this same tree without any scraping changes.
 */

export interface BaseNode {
  type: string;
  sectionSlug: string;
}

export interface HeadingNode extends BaseNode {
  type: 'heading';
  slug: string;
  title: string;
  level: 1 | 2 | 3 | 4;
  parentSlug: string | null;
  hasDiagrams: boolean;
}

export interface ProseNode extends BaseNode {
  type: 'prose';
  markdown: string;
}

export interface CodeNode extends BaseNode {
  type: 'code';
  language?: string;
  text: string;
  github?: GithubLink;
}

export interface GithubLink {
  repo: string;          // "<owner>/<repo>"
  sha: string;           // 40-char hex
  path: string;
  lineRange?: string;    // e.g. "L24-L36" (verbatim from URL fragment)
}

export interface DiagramNode extends BaseNode {
  type: 'diagram';
  svgBase64?: string;
  mermaid?: string;
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  sourceUrl?: string;
  lossy: boolean;
}

export type CanonicalNode = HeadingNode | ProseNode | CodeNode | DiagramNode;

export interface ExtractionResult {
  nodes: CanonicalNode[];
  /** True ONLY when an explicit "Not Found" marker was rendered. */
  notFound: boolean;
  /**
   * True when the SPA rendered an empty shell with neither sections nor a
   * not-found marker. Distinct from `notFound`: empty shell is a TRANSIENT
   * signal (bot challenge / DOM drift / partial render) and MUST NOT be
   * cached as `hasWiki=false`.
   */
  emptyShell: boolean;
  /** First commit SHA found in the page (for cache freshness anchoring). */
  firstCommitSha: string | null;
}

/**
 * Determine each heading's parent slug by longest-prefix-match against the
 * other heading slugs in the page index. CodeWiki uses hierarchical
 * hyphenated slugs: a heading's parent slug is a strict prefix of its own
 * slug, separated by `-`.
 */
export function inferParentSlug(slug: string, allSlugs: ReadonlySet<string>): string | null {
  let best: string | null = null;
  for (const candidate of allSlugs) {
    if (candidate === slug) continue;
    if (slug.startsWith(candidate + '-')) {
      if (best === null || candidate.length > best.length) best = candidate;
    }
  }
  return best;
}
