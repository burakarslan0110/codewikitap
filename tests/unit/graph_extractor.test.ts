/**
 * graph_extractor unit tests.
 *
 * Asserts the pure extractEdges(repo, nodes) function against:
 *   - the real synthetic.html canonical tree (via JSDOM + dom_to_tree),
 *   - hand-built trees that exercise edge cases (dedup, `::` guard, empty
 *     sections, dst_id format conventions).
 *
 * The extractor MUST be deterministic — same input → byte-identical output.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { extractFromDocument } from '../../src/extraction/dom_to_tree.js';
import { extractEdges } from '../../src/services/graph_extractor.js';
import type {
  CanonicalNode,
  CodeNode,
  DiagramNode,
  HeadingNode,
  ProseNode,
} from '../../src/extraction/canonical_tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): Document {
  const html = fs.readFileSync(
    path.resolve(here, '..', 'fixtures', 'codewiki', name),
    'utf8',
  );
  return new JSDOM(html).window.document;
}

function loadSyntheticTree(): CanonicalNode[] {
  return extractFromDocument(loadFixture('synthetic.html')).nodes;
}

describe('extractEdges — synthetic fixture', () => {
  it('emits the expected edge shapes for every section in the synthetic tree', () => {
    const edges = extractEdges('fixture/repo', loadSyntheticTree());

    // code_ref: src/index.ts is referenced by the core section
    const codeRefs = edges.filter((e) => e.edgeType === 'code_ref');
    expect(codeRefs).toHaveLength(1);
    expect(codeRefs[0]).toMatchObject({
      srcKind: 'section',
      srcId: 'fixture/repo#core',
      dstKind: 'file',
      dstId: 'fixture/repo:src/index.ts',
      edgeType: 'code_ref',
      repo: 'fixture/repo',
    });
    expect(codeRefs[0].metadata).toMatchObject({
      sha: 'aabbccddeeff00112233445566778899aabbccdd',
      lineRange: 'L24-L36',
    });

    // diagram_member: 2 nodes (n1, n2) under core
    const members = edges.filter((e) => e.edgeType === 'diagram_member');
    expect(members.map((m) => m.dstId).sort()).toEqual([
      'fixture/repo#core::n1',
      'fixture/repo#core::n2',
    ]);
    expect(members.every((m) => m.srcId === 'fixture/repo#core')).toBe(true);

    // diagram_edge: n1 -> n2
    const dEdges = edges.filter((e) => e.edgeType === 'diagram_edge');
    expect(dEdges).toHaveLength(1);
    expect(dEdges[0]).toMatchObject({
      srcId: 'fixture/repo#core::n1',
      dstId: 'fixture/repo#core::n2',
    });

    // section_link from overview's anchor -> core
    const sectionLinks = edges.filter((e) => e.edgeType === 'section_link');
    expect(sectionLinks).toContainEqual(
      expect.objectContaining({
        srcId: 'fixture/repo#overview',
        dstId: 'fixture/repo#core',
        edgeType: 'section_link',
      }),
    );

    // cross_repo_ref: core-internals references facebook/react via anchor URL
    const crossRefs = edges.filter((e) => e.edgeType === 'cross_repo_ref');
    expect(crossRefs).toContainEqual(
      expect.objectContaining({
        srcId: 'fixture/repo#core-internals',
        dstKind: 'repo',
        dstId: 'facebook/react',
        repo: 'fixture/repo',
      }),
    );
    // The anchor was `#core-hooks` — the metadata should preserve it.
    const fbReact = crossRefs.find((e) => e.dstId === 'facebook/react');
    expect(fbReact!.metadata).toMatchObject({ anchor: 'core-hooks' });
  });

  it('is deterministic: same input → byte-identical output', () => {
    const tree = loadSyntheticTree();
    const a = extractEdges('fixture/repo', tree);
    const b = extractEdges('fixture/repo', tree);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Hand-built tree edge cases
// ---------------------------------------------------------------------------

function heading(slug: string, level: 1 | 2 | 3 | 4, parent: string | null = null): HeadingNode {
  return { type: 'heading', sectionSlug: slug, slug, title: slug, level, parentSlug: parent, hasDiagrams: false };
}
function prose(slug: string, markdown: string): ProseNode {
  return { type: 'prose', sectionSlug: slug, markdown };
}
function code(slug: string, github: { repo: string; sha: string; path: string; lineRange?: string }): CodeNode {
  return { type: 'code', sectionSlug: slug, language: 'ts', text: '// snippet', github };
}
function diagram(slug: string, nodes: Array<{ id: string; label: string }>, edges: Array<{ from: string; to: string; label?: string }>): DiagramNode {
  return { type: 'diagram', sectionSlug: slug, nodes, edges, lossy: false };
}

describe('extractEdges — cross_repo_ref storage invariant (Codex regression)', () => {
  it('every cross_repo_ref row stored has src_kind=section and dst_kind=repo (NOT src=repo)', () => {
    // The Codex CRITICAL finding during planning: stored cross_repo_ref
    // rows have src_kind='section', so the cross_repo OUT query MUST filter
    // by repo column + edge_type and aggregate by dst_id (not by querying
    // src=repo). This invariant test makes regression visible at the
    // extraction layer rather than waiting for a downstream query failure.
    const tree: CanonicalNode[] = [
      heading('a', 2),
      prose('a', 'See [react](https://codewiki.google/github.com/facebook/react#core-hooks).'),
      code('a', { repo: 'facebook/react', sha: 'b'.repeat(40), path: 'src/hooks.ts' }),
      heading('b', 2),
      code('b', { repo: 'vercel/next.js', sha: 'c'.repeat(40), path: 'src/router.ts' }),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const crossRefs = edges.filter((e) => e.edgeType === 'cross_repo_ref');
    expect(crossRefs.length).toBeGreaterThan(0);
    for (const e of crossRefs) {
      expect(e.srcKind).toBe('section');
      expect(e.dstKind).toBe('repo');
      expect(e.srcId.startsWith('fixture/repo#')).toBe(true);
      expect(e.dstId).not.toContain('#');
      expect(e.repo).toBe('fixture/repo');
    }
  });
});

describe('extractEdges — code-block cross-repo signal', () => {
  it('emits cross_repo_ref when CodeNode.github.repo differs from owning repo', () => {
    const tree: CanonicalNode[] = [
      heading('core', 2),
      code('core', { repo: 'facebook/react', sha: 'd5736f098edee62c44f27b053e6e48f5fa443803', path: 'src/foo.ts' }),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const cr = edges.filter((e) => e.edgeType === 'cross_repo_ref');
    expect(cr).toHaveLength(1);
    expect(cr[0]).toMatchObject({
      srcId: 'fixture/repo#core',
      dstKind: 'repo',
      dstId: 'facebook/react',
      repo: 'fixture/repo',
    });
    expect(cr[0].metadata).toMatchObject({ kinds: ['code_block'], file_path: 'src/foo.ts' });
    // The original code_ref still exists, pointing at the foreign file.
    const codeRef = edges.find((e) => e.edgeType === 'code_ref');
    expect(codeRef!.dstId).toBe('facebook/react:src/foo.ts');
  });

  it('does NOT emit cross_repo_ref when CodeNode.github.repo === owning repo', () => {
    const tree: CanonicalNode[] = [
      heading('core', 2),
      code('core', { repo: 'fixture/repo', sha: 'a'.repeat(40), path: 'src/x.ts' }),
    ];
    const edges = extractEdges('fixture/repo', tree);
    expect(edges.filter((e) => e.edgeType === 'cross_repo_ref')).toHaveLength(0);
    expect(edges.filter((e) => e.edgeType === 'code_ref')).toHaveLength(1);
  });
});

describe('extractEdges — Markdown link parsing', () => {
  it('emits section_link for absolute same-repo URL (normalized)', () => {
    const tree: CanonicalNode[] = [
      heading('a', 2),
      prose('a', 'See [B](https://codewiki.google/github.com/fixture/repo#b).'),
      heading('b', 2),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const sl = edges.filter((e) => e.edgeType === 'section_link');
    expect(sl).toHaveLength(1);
    expect(sl[0]).toMatchObject({
      srcId: 'fixture/repo#a',
      dstId: 'fixture/repo#b',
    });
    expect(edges.filter((e) => e.edgeType === 'cross_repo_ref')).toHaveLength(0);
  });

  it('uses exact anchor as dst_id, not parent slug', () => {
    const tree: CanonicalNode[] = [
      heading('a', 2),
      prose('a', 'See [Internals](#core-internals).'),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const sl = edges.find((e) => e.edgeType === 'section_link');
    expect(sl!.dstId).toBe('fixture/repo#core-internals');
  });

  it('dedupes anchor + code-block links to the same other repo into a single cross_repo_ref', () => {
    const tree: CanonicalNode[] = [
      heading('a', 2),
      prose('a', 'See [react](https://codewiki.google/github.com/facebook/react#core-hooks).'),
      code('a', { repo: 'facebook/react', sha: 'b'.repeat(40), path: 'src/hooks.ts' }),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const cr = edges.filter((e) => e.edgeType === 'cross_repo_ref' && e.dstId === 'facebook/react');
    expect(cr).toHaveLength(1);
    expect((cr[0].metadata!.kinds as string[]).sort()).toEqual(['anchor_link', 'code_block']);
  });
});

describe('extractEdges — prose-level github blob URLs (v2.8)', () => {
  it('emits code_ref for prose-level same-repo github blob URL', () => {
    const tree: CanonicalNode[] = [
      heading('core', 2),
      prose(
        'core',
        'See [BabelPlugin](https://github.com/fixture/repo/blob/aabbccddeeff00112233445566778899aabbccdd/src/babel/Plugin.ts#L24).',
      ),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const codeRefs = edges.filter((e) => e.edgeType === 'code_ref');
    expect(codeRefs).toHaveLength(1);
    expect(codeRefs[0]).toMatchObject({
      srcKind: 'section',
      srcId: 'fixture/repo#core',
      dstKind: 'file',
      dstId: 'fixture/repo:src/babel/Plugin.ts',
      edgeType: 'code_ref',
      repo: 'fixture/repo',
    });
    expect(codeRefs[0].metadata).toMatchObject({
      sha: 'aabbccddeeff00112233445566778899aabbccdd',
      lineRange: 'L24',
      source: 'prose_link',
    });
    // Same-repo: must NOT emit cross_repo_ref.
    expect(edges.filter((e) => e.edgeType === 'cross_repo_ref')).toHaveLength(0);
  });

  it('emits code_ref + cross_repo_ref{kinds:[prose_link]} for cross-repo prose URL with line range', () => {
    const tree: CanonicalNode[] = [
      heading('core', 2),
      prose(
        'core',
        'See [react useState](https://github.com/facebook/react/blob/d5736f098edee62c44f27b053e6e48f5fa443803/packages/react/src/ReactHooks.ts#L42-L60).',
      ),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const codeRefs = edges.filter((e) => e.edgeType === 'code_ref');
    expect(codeRefs).toHaveLength(1);
    expect(codeRefs[0]).toMatchObject({
      srcKind: 'section',
      srcId: 'fixture/repo#core',
      dstKind: 'file',
      dstId: 'facebook/react:packages/react/src/ReactHooks.ts',
      edgeType: 'code_ref',
      repo: 'fixture/repo',
    });
    expect(codeRefs[0].metadata).toMatchObject({
      sha: 'd5736f098edee62c44f27b053e6e48f5fa443803',
      lineRange: 'L42-L60',
      source: 'prose_link',
    });
    const crossRefs = edges.filter((e) => e.edgeType === 'cross_repo_ref');
    expect(crossRefs).toHaveLength(1);
    expect(crossRefs[0]).toMatchObject({
      srcKind: 'section',
      srcId: 'fixture/repo#core',
      dstKind: 'repo',
      dstId: 'facebook/react',
      edgeType: 'cross_repo_ref',
      repo: 'fixture/repo',
    });
    expect((crossRefs[0].metadata?.kinds as string[]).sort()).toEqual(['prose_link']);
    expect(crossRefs[0].metadata).toMatchObject({
      anchor_text: 'react useState',
      file_path: 'packages/react/src/ReactHooks.ts',
      sha: 'd5736f098edee62c44f27b053e6e48f5fa443803',
    });
  });

  it('handles URLs with ?query string by excluding query from the captured path', () => {
    const tree: CanonicalNode[] = [
      heading('core', 2),
      prose(
        'core',
        'See [doc](https://github.com/fixture/repo/blob/aabbccddeeff00112233445566778899aabbccdd/compiler/docs/README.md?plain=1#L192).',
      ),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const codeRefs = edges.filter((e) => e.edgeType === 'code_ref');
    expect(codeRefs).toHaveLength(1);
    expect(codeRefs[0].dstId).toBe('fixture/repo:compiler/docs/README.md');
    expect(codeRefs[0].metadata).toMatchObject({ lineRange: 'L192' });
  });

  it('merges prose_link into existing code_block + anchor_link kinds via dedup', () => {
    const tree: CanonicalNode[] = [
      heading('core', 2),
      // anchor_link via codewiki.google URL
      prose(
        'core',
        'See [react](https://codewiki.google/github.com/facebook/react#core-hooks) and [also react](https://github.com/facebook/react/blob/d5736f098edee62c44f27b053e6e48f5fa443803/packages/react/src/index.ts).',
      ),
      // code_block via CodeNode.github pointing at the same other repo
      code('core', {
        repo: 'facebook/react',
        sha: 'd5736f098edee62c44f27b053e6e48f5fa443803',
        path: 'packages/react/src/hooks.ts',
      }),
    ];
    const edges = extractEdges('fixture/repo', tree);
    const crossRefs = edges.filter(
      (e) => e.edgeType === 'cross_repo_ref' && e.dstId === 'facebook/react',
    );
    // ALL three sources point at facebook/react → must dedup to ONE row.
    expect(crossRefs).toHaveLength(1);
    expect((crossRefs[0].metadata?.kinds as string[]).sort()).toEqual([
      'anchor_link',
      'code_block',
      'prose_link',
    ]);
  });

  it('does NOT emit prose-link edges for URLs nested inside fenced code blocks', () => {
    // The dom_to_tree extractor strips <pre> blocks BEFORE turndown so code-
    // fenced github URLs become CodeNodes (with structured github linkage),
    // never ProseNodes. This unit-level test exercises the contract by
    // showing that a CodeNode with text containing a github URL does NOT
    // emit a prose_link cross_repo_ref — only the CodeNode.github reference
    // (code_block kind) survives.
    const tree: CanonicalNode[] = [
      heading('core', 2),
      // Code node text contains a URL string, but it should NOT be parsed
      // for prose-level extraction (only ProseNode markdown is scanned).
      {
        type: 'code',
        sectionSlug: 'core',
        language: 'ts',
        text: '// See https://github.com/facebook/react/blob/d5736f098edee62c44f27b053e6e48f5fa443803/x.ts',
        github: {
          repo: 'facebook/react',
          sha: 'd5736f098edee62c44f27b053e6e48f5fa443803',
          path: 'src/foo.ts',
        },
      },
    ];
    const edges = extractEdges('fixture/repo', tree);
    const crossRefs = edges.filter(
      (e) => e.edgeType === 'cross_repo_ref' && e.dstId === 'facebook/react',
    );
    expect(crossRefs).toHaveLength(1);
    // Only the code_block kind from CodeNode.github — no prose_link.
    expect((crossRefs[0].metadata?.kinds as string[]).sort()).toEqual(['code_block']);
  });
});

describe('extractEdges — diagram node `::` guard', () => {
  it('skips diagram nodes whose id contains "::" with a warning', () => {
    const tree: CanonicalNode[] = [
      heading('core', 2),
      diagram('core', [{ id: 'good', label: 'OK' }, { id: 'bad::id', label: 'Bad' }], [{ from: 'good', to: 'bad::id' }]),
    ];
    const edges = extractEdges('fixture/repo', tree);
    // good: emitted as diagram_member. bad::id: skipped. The diagram_edge
    // referencing bad::id is also skipped (since one endpoint is invalid).
    const members = edges.filter((e) => e.edgeType === 'diagram_member');
    expect(members.map((m) => m.dstId)).toEqual(['fixture/repo#core::good']);
    expect(edges.filter((e) => e.edgeType === 'diagram_edge')).toHaveLength(0);
  });
});

describe('extractEdges — orphan content', () => {
  it('ignores content nodes that appear before any heading', () => {
    const tree: CanonicalNode[] = [
      // No heading first; the prose has sectionSlug pointing at a heading
      // that doesn't exist in the tree.
      prose('orphan', 'Stray.'),
      heading('a', 2),
    ];
    const edges = extractEdges('fixture/repo', tree);
    // No edges — orphan prose is ignored, the heading has nothing to link to.
    expect(edges).toHaveLength(0);
  });
});
