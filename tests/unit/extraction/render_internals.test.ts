/**
 * Smoke test for the render_internals helpers extracted from serializer.ts.
 * The full behavior contract for these helpers is covered by serializer.test.ts
 * (which exercises them through `serialize()`); this file just confirms the
 * direct-call surface that chunker.ts depends on.
 */

import { describe, it, expect } from 'vitest';

import { estimateTokens, renderNode } from '../../../src/extraction/render_internals.js';
import type { CanonicalNode } from '../../../src/extraction/canonical_tree.js';

describe('estimateTokens', () => {
  it('returns 1 for a 4-character string', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('rounds up partial tokens', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('renderNode', () => {
  it('renders a heading with the right number of hashes', () => {
    const n: CanonicalNode = {
      type: 'heading',
      sectionSlug: 'core',
      slug: 'core',
      title: 'Core',
      level: 2,
      parentSlug: null,
      hasDiagrams: false,
    };
    expect(renderNode(n)).toBe('## Core\n');
  });

  it('renders prose trimmed + newline', () => {
    const n: CanonicalNode = {
      type: 'prose',
      sectionSlug: 'core',
      markdown: '  some prose  ',
    };
    expect(renderNode(n)).toBe('some prose\n');
  });

  it('renders a code block with github source link when present', () => {
    const n: CanonicalNode = {
      type: 'code',
      sectionSlug: 'core',
      language: 'ts',
      text: "console.log('x')",
      github: { repo: 'fb/react', sha: 'abc123', path: 'src/x.ts', lineRange: 'L1-L3' },
    };
    const out = renderNode(n);
    expect(out).toContain('```ts\n');
    expect(out).toContain("console.log('x')");
    expect(out).toContain('https://github.com/fb/react/blob/abc123/src/x.ts#L1-L3');
  });

  it('renders a diagram via mermaid when not lossy', () => {
    const n: CanonicalNode = {
      type: 'diagram',
      sectionSlug: 'arch',
      mermaid: 'graph TD; A-->B',
      nodes: [],
      edges: [],
      lossy: false,
    };
    expect(renderNode(n)).toBe('```mermaid\ngraph TD; A-->B\n```\n');
  });

  it('renders a diagram fallback (text node/edge listing) when lossy', () => {
    const n: CanonicalNode = {
      type: 'diagram',
      sectionSlug: 'arch',
      nodes: [{ id: 'n1', label: 'Start' }],
      edges: [{ from: 'n1', to: 'n2' }],
      sourceUrl: 'https://example/diagram',
      lossy: true,
    };
    const out = renderNode(n);
    expect(out).toContain('> Diagram (text fallback)');
    expect(out).toContain('n1="Start"');
    expect(out).toContain('n1 -> n2');
    expect(out).toContain('https://example/diagram');
  });
});
