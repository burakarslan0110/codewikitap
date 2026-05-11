/**
 * Canonical tree → Chunk[] for embedding.
 *
 * Per-heading-section chunking (NOT leaf-only). Every heading in the canonical
 * tree opens a new section identified by `sectionSlug`; the prose / code /
 * diagram nodes immediately following it (with the same `sectionSlug`) are
 * the section's content. Each section emits at least one chunk — including
 * parent sections whose own content appears before a child heading opens
 * (e.g. `core` in the synthetic fixture, which carries the entry-point prose
 * + code block before `core-internals` appears).
 *
 * Pure function: same input → same output, byte-for-byte. No I/O, no async.
 */

import { CanonicalNode, GithubLink, HeadingNode } from './canonical_tree.js';
import { Chunk } from '../types.js';
import { estimateTokens, renderNode } from './render_internals.js';

export interface ChunkOptions {
  /** Soft ceiling that triggers adaptive split inside a section. */
  maxTokens: number;
  /** Overlap window (in tokens) for split chunks within the same section. */
  overlapTokens: number;
}

/**
 * Group `nodes` by `sectionSlug` while preserving document order. Each
 * returned group starts with the section's HeadingNode followed by its
 * content nodes (prose / code / diagram).
 */
function groupBySection(nodes: CanonicalNode[]): CanonicalNode[][] {
  const groups: CanonicalNode[][] = [];
  let current: CanonicalNode[] | null = null;
  let currentSlug: string | null = null;

  for (const n of nodes) {
    if (n.type === 'heading') {
      // Heading opens a new section.
      current = [n];
      currentSlug = n.slug;
      groups.push(current);
    } else if (current && n.sectionSlug === currentSlug) {
      current.push(n);
    } else {
      // Non-heading node before any heading — drop. The canonical tree
      // contract guarantees the first node of each section is a heading,
      // so this branch only fires on malformed input.
    }
  }

  return groups;
}

/**
 * Render a section group to its full Markdown text by concatenating each
 * node's projection. The first node is always the heading, so the chunk
 * begins with `# Title\n`.
 */
function renderSection(section: CanonicalNode[]): string {
  return section.map(renderNode).join('\n');
}

/** Pull the github link from a section group, but only if it has exactly one
 * CodeNode with a github reference. Multiple CodeNodes → ambiguous → return
 * undefined to avoid mis-anchoring a chunk to one of several files. */
function extractGithub(section: CanonicalNode[]): GithubLink | undefined {
  const codeNodesWithGithub = section.filter(
    (n): n is CanonicalNode & { type: 'code'; github: GithubLink } =>
      n.type === 'code' && n.github !== undefined,
  );
  if (codeNodesWithGithub.length === 1) {
    return codeNodesWithGithub[0].github;
  }
  return undefined;
}

/**
 * Split a long rendered-section text into paragraph-aligned windows of at
 * most `maxTokens` tokens each, with `overlapTokens` of trailing-paragraph
 * overlap between adjacent windows. Never crosses section boundaries because
 * the caller invokes this per-section.
 */
function splitWithOverlap(
  text: string,
  opts: ChunkOptions,
): string[] {
  const paragraphs = text.split('\n\n').filter((p) => p.length > 0);
  if (paragraphs.length === 0) return [text];

  const windows: string[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const flush = (carryParagraphs: string[]): void => {
    if (buf.length === 0) return;
    windows.push(buf.join('\n\n'));
    buf = [...carryParagraphs];
    bufTokens = buf.reduce((n, p) => n + estimateTokens(p), 0);
  };

  for (const p of paragraphs) {
    const pTokens = estimateTokens(p);
    if (bufTokens + pTokens > opts.maxTokens && buf.length > 0) {
      // Compute the trailing paragraphs that fit within overlapTokens.
      const carry: string[] = [];
      let carryTokens = 0;
      for (let i = buf.length - 1; i >= 0; i--) {
        const t = estimateTokens(buf[i]);
        if (carryTokens + t > opts.overlapTokens) break;
        carry.unshift(buf[i]);
        carryTokens += t;
      }
      flush(carry);
    }
    buf.push(p);
    bufTokens += pTokens;
  }
  if (buf.length > 0) {
    windows.push(buf.join('\n\n'));
  }
  return windows;
}

/**
 * Produce chunks for one repo's canonical tree.
 *
 * @param repo  "<owner>/<repo>"
 * @param pageSlug Always `'__root__'` in v2 (kept for forward compat).
 * @param nodes Canonical tree from `extractFromPage`/`extractFromDocument`.
 * @param opts  Adaptive-split knobs.
 */
export function chunkPage(
  repo: string,
  pageSlug: string,
  nodes: CanonicalNode[],
  opts: ChunkOptions,
): Chunk[] {
  const groups = groupBySection(nodes);
  const out: Chunk[] = [];

  for (const section of groups) {
    const heading = section[0] as HeadingNode;
    const sectionSlug = heading.slug;
    const github = extractGithub(section);
    const text = renderSection(section);

    const tokens = estimateTokens(text);
    if (tokens <= opts.maxTokens) {
      out.push({
        repo,
        pageSlug,
        sectionSlug,
        ordinal: 0,
        text,
        ...(github && text.includes(github.sha) ? { github } : {}),
      });
      continue;
    }

    const windows = splitWithOverlap(text, opts);
    windows.forEach((winText, idx) => {
      const chunk: Chunk = {
        repo,
        pageSlug,
        sectionSlug,
        ordinal: idx,
        text: winText,
      };
      // Attach github only to the window whose text actually contains the
      // rendered code-block source line (defends against split chunks that
      // lose the code).
      if (github && winText.includes(github.sha)) {
        chunk.github = github;
      }
      out.push(chunk);
    });
  }

  return out;
}
