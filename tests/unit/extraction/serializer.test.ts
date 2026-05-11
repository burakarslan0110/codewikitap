import { describe, it, expect } from 'vitest';

import {
  serialize,
  CITATION_FOOTER_TEMPLATE,
  CITATION_FOOTER_REGEX,
} from '../../../src/extraction/serializer.js';
import type { CanonicalNode } from '../../../src/extraction/canonical_tree.js';
import type { Citation } from '../../../src/types.js';
import { SerializerError } from '../../../src/types.js';

const CITATION: Citation = {
  sourceUrl: 'https://codewiki.google/github.com/facebook/react#core',
  commitSha: 'd5736f098edee62c44f27b053e6e48f5fa443803',
  lastChecked: new Date(0).toISOString(),
};

const TREE: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core overview text.' },
  {
    type: 'code', sectionSlug: 'core', language: 'ts', text: "console.log('hi')",
    github: { repo: 'facebook/react', sha: 'd5736f098edee62c44f27b053e6e48f5fa443803', path: 'src/x.ts', lineRange: 'L1-L1' },
  },
  {
    type: 'diagram', sectionSlug: 'core',
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'b' }],
    mermaid: 'flowchart TD\n  N0["A"]\n  N1["B"]\n  N0 --> N1',
    lossy: false,
  },
];

describe('serialize', () => {
  it('emits Markdown with heading + prose in document order', () => {
    const r = serialize(TREE, CITATION, { maxTokens: 10_000 });
    expect(r.markdown).toMatch(/^## Core/m);
    expect(r.markdown).toContain('Core overview text.');
    expect(typeof r.truncated).toBe('boolean');
  });

  it('serialises code blocks with language tag and the github source link', () => {
    const r = serialize(TREE, CITATION, { maxTokens: 10_000 });
    expect(r.markdown).toMatch(/```ts[\s\S]*console\.log\('hi'\)[\s\S]*```/);
    expect(r.markdown).toContain('github.com/facebook/react/blob/d5736f098edee62c44f27b053e6e48f5fa443803/src/x.ts#L1-L1');
  });

  it('serialises diagrams as Mermaid fenced blocks when available, plain blockquote otherwise', () => {
    const r = serialize(TREE, CITATION, { maxTokens: 10_000 });
    expect(r.markdown).toMatch(/```mermaid\nflowchart TD/);

    const lossyTree: CanonicalNode[] = [
      { type: 'heading', sectionSlug: 'x', slug: 'x', title: 'X', level: 2, parentSlug: null, hasDiagrams: false },
      { type: 'diagram', sectionSlug: 'x', mermaid: undefined, nodes: [{ id: 'a', label: 'A' }], edges: [], lossy: true },
    ];
    const r2 = serialize(lossyTree, CITATION, { maxTokens: 10_000 });
    expect(r2.markdown).toMatch(/> Diagram \(text fallback\)/);
  });

  it('always appends the canonical citation footer matching CITATION_FOOTER_REGEX', () => {
    const r = serialize(TREE, CITATION, { maxTokens: 10_000 });
    expect(r.markdown).toMatch(CITATION_FOOTER_REGEX);
    // The exact template was used.
    expect(CITATION_FOOTER_TEMPLATE.includes('${sourceUrl}')).toBe(true);
    expect(CITATION_FOOTER_TEMPLATE.includes('${commitSha}')).toBe(true);
  });

  it('PSF-004 layer 3: throws SerializerError on invalid commitSha (empty)', () => {
    // Pre-Task-6: empty commitSha silently produced `pinned to commit . AI-generated...`
    // which fails the byte-equal CITATION_FOOTER_REGEX.
    // Post-Task-6: serializer rejects at the boundary before any text is rendered.
    const badCitation: Citation = { ...CITATION, commitSha: '' };
    expect(() => serialize(TREE, badCitation, { maxTokens: 10_000 })).toThrow(SerializerError);
  });

  it('PSF-004 layer 3: throws SerializerError on commitSha with wrong length', () => {
    const badCitation: Citation = { ...CITATION, commitSha: 'abc123' };
    expect(() => serialize(TREE, badCitation, { maxTokens: 10_000 })).toThrow(SerializerError);
  });

  it('PSF-004 layer 3: throws SerializerError on commitSha with non-hex characters', () => {
    const badCitation: Citation = { ...CITATION, commitSha: 'g'.repeat(40) };
    expect(() => serialize(TREE, badCitation, { maxTokens: 10_000 })).toThrow(SerializerError);
  });

  it('triggers the truncation marker when token estimate exceeds maxTokens', () => {
    // Construct a long prose node so estimation kicks in well above maxTokens.
    const longProse = 'x'.repeat(20_000);
    const longTree: CanonicalNode[] = [
      { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
      { type: 'prose', sectionSlug: 'core', markdown: longProse },
    ];
    const r = serialize(longTree, CITATION, { maxTokens: 100 });
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain('_Truncated to fit token budget._');
    // Citation footer is still appended after truncation.
    expect(r.markdown).toMatch(CITATION_FOOTER_REGEX);
  });

  it('still emits the first node when it alone exceeds maxTokens (no empty body)', () => {
    // Regression for E2E finding F4: when the very first node's token estimate
    // exceeds maxTokens, the pre-fix loop broke before pushing anything, so
    // get_page returned an empty body — just "_Truncated_" + footer — which
    // gives the consumer nothing to anchor on. Post-fix: always emit at least
    // the first node alongside the truncation notice.
    const longProse = 'x'.repeat(20_000);
    const oversizedFirstTree: CanonicalNode[] = [
      { type: 'prose', sectionSlug: 'core', markdown: longProse },
    ];
    const r = serialize(oversizedFirstTree, CITATION, { maxTokens: 10 });
    expect(r.truncated).toBe(true);
    expect(r.markdown).toMatch(/x{100,}/);
    expect(r.markdown).toContain('_Truncated to fit token budget._');
    expect(r.markdown).toMatch(CITATION_FOOTER_REGEX);
  });

  it('truncation tail omits inline availableSubsections list (uses JSON envelope instead)', () => {
    const longProse = 'x'.repeat(20_000);
    const longTree: CanonicalNode[] = [
      { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
      { type: 'prose', sectionSlug: 'core', markdown: longProse },
    ];
    const r = serialize(longTree, CITATION, { maxTokens: 100 });
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain('_Truncated to fit token budget._');
    expect(r.markdown).not.toContain('Available subsections you can request via');
    expect(r.markdown).not.toMatch(/- `core-internals`/);
    expect(r.markdown).not.toMatch(/- `core-deeper`/);
    expect(r.markdown).not.toMatch(/- `core-yet-another`/);
    expect(r.markdown).toMatch(CITATION_FOOTER_REGEX);
  });
});

