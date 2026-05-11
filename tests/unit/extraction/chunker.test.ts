/**
 * Chunker tests — locks the v2 contract:
 *   - Every heading section produces ≥ 1 chunk (NOT leaf-only).
 *   - Adaptive split inside a section only (overlap never crosses sections).
 *   - github link is preserved when a section's chunk contains the rendered code block.
 */

import { describe, it, expect } from 'vitest';

import { chunkPage } from '../../../src/extraction/chunker.js';
import type { CanonicalNode } from '../../../src/extraction/canonical_tree.js';

const SYNTHETIC_NODES: CanonicalNode[] = [
  { type: 'heading', sectionSlug: 'overview', slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'overview', markdown: 'The fixture repo demonstrates extraction.' },
  { type: 'heading', sectionSlug: 'core', slug: 'core', title: 'Core', level: 2, parentSlug: null, hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core', markdown: 'Core module provides the entry point in `src/index.ts`.' },
  {
    type: 'code',
    sectionSlug: 'core',
    language: 'ts',
    text: 'export function entry() {\n  return 42;\n}',
    github: { repo: 'fixture/repo', sha: 'aabbccddeeff00112233445566778899aabbccdd', path: 'src/index.ts', lineRange: 'L24-L36' },
  },
  { type: 'heading', sectionSlug: 'core-internals', slug: 'core-internals', title: 'Internals', level: 3, parentSlug: 'core', hasDiagrams: false },
  { type: 'prose', sectionSlug: 'core-internals', markdown: 'Internals are nested under Core.' },
  { type: 'heading', sectionSlug: 'api', slug: 'api', title: 'API', level: 2, parentSlug: null, hasDiagrams: false },
];

const REPO = 'fixture/repo';
const PAGE = '__root__';
const DEFAULT_OPTS = { maxTokens: 512, overlapTokens: 64 };

describe('chunkPage — every heading section produces a chunk', () => {
  it('emits one chunk per heading in the synthetic tree (NOT leaf-only)', () => {
    const chunks = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    const slugs = new Set(chunks.map((c) => c.sectionSlug));
    expect(slugs).toEqual(new Set(['overview', 'core', 'core-internals', 'api']));
    // 4 sections, none split (all small) → exactly 4 chunks.
    expect(chunks.length).toBe(4);
  });

  it('the `core` chunk contains BOTH the entry-point prose AND the rendered code block', () => {
    const chunks = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    const core = chunks.find((c) => c.sectionSlug === 'core');
    expect(core).toBeDefined();
    expect(core!.text).toContain('Core module provides the entry point');
    expect(core!.text).toContain('export function entry()');
    // The rendered fence-block source link must be present.
    expect(core!.text).toContain('aabbccddeeff00112233445566778899aabbccdd');
  });

  it('emits a heading-only chunk for an empty section (api has no content)', () => {
    const chunks = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    const api = chunks.find((c) => c.sectionSlug === 'api');
    expect(api).toBeDefined();
    expect(api!.text).toContain('API');
    expect(api!.text.trim().length).toBeGreaterThan(0);
  });
});

describe('chunkPage — chunk shape', () => {
  it('every chunk carries (repo, pageSlug, sectionSlug, ordinal, text)', () => {
    const chunks = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    for (const c of chunks) {
      expect(c.repo).toBe(REPO);
      expect(c.pageSlug).toBe(PAGE);
      expect(typeof c.sectionSlug).toBe('string');
      expect(typeof c.ordinal).toBe('number');
      expect(c.text.length).toBeGreaterThan(0);
    }
  });

  it('whole-section chunks have ordinal 0', () => {
    const chunks = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    for (const c of chunks) expect(c.ordinal).toBe(0);
  });

  it('attaches github link when section has exactly one CodeNode with github', () => {
    const chunks = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    const core = chunks.find((c) => c.sectionSlug === 'core');
    expect(core?.github).toBeDefined();
    expect(core!.github!.repo).toBe('fixture/repo');
    expect(core!.github!.path).toBe('src/index.ts');
  });

  it('does NOT attach github link to sections without a code block', () => {
    const chunks = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    const overview = chunks.find((c) => c.sectionSlug === 'overview');
    expect(overview?.github).toBeUndefined();
  });
});

describe('chunkPage — adaptive paragraph splitting', () => {
  it('splits a section that exceeds maxTokens into multiple ordinals', () => {
    const longProse = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with ample content to consume tokens. `.repeat(10)).join('\n\n');
    const nodes: CanonicalNode[] = [
      { type: 'heading', sectionSlug: 'long', slug: 'long', title: 'Long', level: 2, parentSlug: null, hasDiagrams: false },
      { type: 'prose', sectionSlug: 'long', markdown: longProse },
    ];
    const chunks = chunkPage(REPO, PAGE, nodes, { maxTokens: 200, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // All chunks belong to the same section.
    expect(chunks.every((c) => c.sectionSlug === 'long')).toBe(true);
    // Ordinals are 0..n-1 contiguous.
    const ordinals = chunks.map((c) => c.ordinal).sort((a, b) => a - b);
    expect(ordinals).toEqual(ordinals.map((_, i) => i));
  });

  it('overlap stays inside section boundary (no cross-section bleed)', () => {
    // Two adjacent sections, both modestly sized — no split needed, no overlap.
    const nodes: CanonicalNode[] = [
      { type: 'heading', sectionSlug: 's1', slug: 's1', title: 'S1', level: 2, parentSlug: null, hasDiagrams: false },
      { type: 'prose', sectionSlug: 's1', markdown: 'Section 1 content.' },
      { type: 'heading', sectionSlug: 's2', slug: 's2', title: 'S2', level: 2, parentSlug: null, hasDiagrams: false },
      { type: 'prose', sectionSlug: 's2', markdown: 'Section 2 content.' },
    ];
    const chunks = chunkPage(REPO, PAGE, nodes, DEFAULT_OPTS);
    const s1 = chunks.find((c) => c.sectionSlug === 's1');
    const s2 = chunks.find((c) => c.sectionSlug === 's2');
    expect(s1!.text).not.toContain('Section 2 content');
    expect(s2!.text).not.toContain('Section 1 content');
  });
});

describe('chunkPage — determinism', () => {
  it('produces identical output across two calls (snapshot)', () => {
    const a = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    const b = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    expect(a).toEqual(b);
  });
});

describe('chunkPage — pure function', () => {
  it('returns synchronously (no async, no Promise)', () => {
    const result = chunkPage(REPO, PAGE, SYNTHETIC_NODES, DEFAULT_OPTS);
    expect(Array.isArray(result)).toBe(true);
    // If it were a Promise, .then would exist.
    expect((result as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
