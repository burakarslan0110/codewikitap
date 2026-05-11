/**
 * Heading-aware sub-section retrieval.
 *
 * Given a canonical tree and a target slug, returns the subset of nodes that
 * belong to the target heading's subtree (the heading itself + all descendant
 * sections + their content nodes), preserving document order. Used by
 * `get_page` to drill down on long pages without an embedding stack.
 */

import { CanonicalNode } from './canonical_tree.js';

export function subtreeFor(nodes: CanonicalNode[], targetSlug: string): CanonicalNode[] {
  // Build a slug → parent map from the heading nodes.
  const parentBySlug = new Map<string, string | null>();
  for (const n of nodes) {
    if (n.type === 'heading') parentBySlug.set(n.slug, n.parentSlug);
  }

  if (!parentBySlug.has(targetSlug)) return [];

  // A slug is in the subtree iff its ancestor chain reaches targetSlug.
  function isInSubtree(slug: string): boolean {
    let cur: string | null = slug;
    while (cur !== null) {
      if (cur === targetSlug) return true;
      cur = parentBySlug.get(cur) ?? null;
    }
    return false;
  }

  return nodes.filter((n) => isInSubtree(n.sectionSlug));
}
