import { describe, it, expect } from 'vitest';

import { subtreeFor } from '../../../src/extraction/sub_section.js';
import type { CanonicalNode, HeadingNode } from '../../../src/extraction/canonical_tree.js';

function h(slug: string, parentSlug: string | null, level: 1 | 2 | 3 | 4): HeadingNode {
  return { type: 'heading', sectionSlug: slug, slug, title: slug, level, parentSlug, hasDiagrams: false };
}
function p(sectionSlug: string, text: string): CanonicalNode {
  return { type: 'prose', sectionSlug, markdown: text };
}

const TREE: CanonicalNode[] = [
  h('overview', null, 1),
  p('overview', 'Overview text'),
  h('core', null, 2),
  p('core', 'Core text'),
  h('core-internals', 'core', 3),
  p('core-internals', 'Internals text'),
  h('core-internals-detail', 'core-internals', 4),
  p('core-internals-detail', 'Detail text'),
  h('api', null, 2),
  p('api', 'API text'),
];

describe('subtreeFor', () => {
  it('returns the whole tree when slug is the root-level slug containing all others', () => {
    // No literal "root" slug — but every top-level node has parentSlug=null.
    // Asking for an existing slug returns its subtree, not "all".
    const r = subtreeFor(TREE, 'core');
    expect(r.map((n) => n.sectionSlug)).toEqual([
      'core', 'core', 'core-internals', 'core-internals', 'core-internals-detail', 'core-internals-detail',
    ]);
  });

  it('returns only the leaf section when slug is a leaf', () => {
    const r = subtreeFor(TREE, 'core-internals-detail');
    expect(r.map((n) => n.sectionSlug)).toEqual(['core-internals-detail', 'core-internals-detail']);
  });

  it('returns an empty array when slug is not in the tree', () => {
    const r = subtreeFor(TREE, 'no-such-slug');
    expect(r).toEqual([]);
  });

  it('does NOT include peer-level sections', () => {
    const r = subtreeFor(TREE, 'core');
    const slugs = r.map((n) => n.sectionSlug);
    expect(slugs).not.toContain('overview');
    expect(slugs).not.toContain('api');
  });
});
