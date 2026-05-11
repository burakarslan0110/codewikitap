import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { extractFromDocument } from '../../../src/extraction/dom_to_tree.js';
import type { CodeNode, DiagramNode, HeadingNode, ProseNode } from '../../../src/extraction/canonical_tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
function loadFixture(name: string): Document {
  const html = fs.readFileSync(
    path.resolve(here, '..', '..', 'fixtures', 'codewiki', name),
    'utf8',
  );
  return new JSDOM(html).window.document;
}

describe('extractFromDocument', () => {
  it('finds every body-content-section as a heading + content group', () => {
    const result = extractFromDocument(loadFixture('synthetic.html'));
    expect(result.notFound).toBe(false);
    const headings = result.nodes.filter((n) => n.type === 'heading') as HeadingNode[];
    expect(headings.map((h) => h.slug)).toEqual(['overview', 'core', 'core-internals', 'api']);
    expect(headings.find((h) => h.slug === 'overview')!.level).toBe(1);
    expect(headings.find((h) => h.slug === 'core')!.level).toBe(2);
    expect(headings.find((h) => h.slug === 'core-internals')!.level).toBe(3);
  });

  it('infers parentSlug via longest hyphen-prefix match', () => {
    const result = extractFromDocument(loadFixture('synthetic.html'));
    const headings = result.nodes.filter((n) => n.type === 'heading') as HeadingNode[];
    expect(headings.find((h) => h.slug === 'overview')!.parentSlug).toBeNull();
    expect(headings.find((h) => h.slug === 'core')!.parentSlug).toBeNull();
    expect(headings.find((h) => h.slug === 'core-internals')!.parentSlug).toBe('core');
    expect(headings.find((h) => h.slug === 'api')!.parentSlug).toBeNull();
  });

  it('extracts prose to markdown and tags it with the correct sectionSlug', () => {
    const result = extractFromDocument(loadFixture('synthetic.html'));
    const proseNodes = result.nodes.filter((n) => n.type === 'prose') as ProseNode[];
    expect(proseNodes.length).toBeGreaterThan(0);
    const overview = proseNodes.find((p) => p.sectionSlug === 'overview');
    expect(overview).toBeDefined();
    // Markdown should contain plain text and a link reference.
    expect(overview!.markdown).toContain('extraction of every element type');
  });

  it('extracts code blocks with embedded github commit SHA links', () => {
    const result = extractFromDocument(loadFixture('synthetic.html'));
    const codeNodes = result.nodes.filter((n) => n.type === 'code') as CodeNode[];
    expect(codeNodes.length).toBe(1);
    const code = codeNodes[0];
    expect(code.language).toBe('ts');
    expect(code.text).toContain('export function entry()');
    expect(code.github).toEqual({
      repo: 'fixture/repo',
      sha: 'aabbccddeeff00112233445566778899aabbccdd',
      path: 'src/index.ts',
      lineRange: 'L24-L36',
    });
    // First commit SHA in the page is exposed at the result level.
    expect(result.firstCommitSha).toBe('aabbccddeeff00112233445566778899aabbccdd');
  });

  it('extracts diagrams from <code-documentation-diagram-inline> with SVG payload', () => {
    const result = extractFromDocument(loadFixture('synthetic.html'));
    const diagrams = result.nodes.filter((n) => n.type === 'diagram') as DiagramNode[];
    expect(diagrams.length).toBe(1);
    const d = diagrams[0];
    expect(d.sectionSlug).toBe('core');
    // The Diagram should at minimum expose the raw nodes/edges from the SVG <g> tags.
    expect(d.nodes.length).toBeGreaterThanOrEqual(2);
    expect(d.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('detects the not-found page and returns notFound:true with empty nodes', () => {
    const result = extractFromDocument(loadFixture('not-found.html'));
    expect(result.notFound).toBe(true);
    expect(result.nodes).toEqual([]);
  });

  it('detects the production not-found page (<app-not-found> + 404 copy) as notFound, NOT emptyShell', () => {
    // Regression for: list_pages('iarna/iarna-toml') falsely returning the
    // "empty SPA shell — possible bot challenge" error. CodeWiki's live
    // not-found page renders <app-not-found> with body copy "404 / This page
    // doesn't exist" — none of the legacy text hints match, so the no-wiki
    // signal must come from the stable web-component tag, not body text.
    const result = extractFromDocument(loadFixture('not-found-live.html'));
    expect(result.notFound).toBe(true);
    expect(result.emptyShell).toBe(false);
    expect(result.nodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v2.8: production CodeWiki wraps Graphviz SVG as base64 inside <image>
// inside the outer <svg>. Pre-v2.8, the extractor ran convertGraphvizSvg
// against the outer wrapper (no g.node/g.edge classes) and produced empty
// DiagramNodes silently.
// ---------------------------------------------------------------------------

const MINI_GRAPHVIZ_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><g class="graph">' +
  '<g id="node1" class="node"><title>n1</title><text>Start</text></g>' +
  '<g id="node2" class="node"><title>n2</title><text>End</text></g>' +
  '<g id="edge1" class="edge"><title>n1-&gt;n2</title><text>flow</text></g>' +
  '</g></svg>';

function buildProdShapeDocument(innerSvgPayload: string): Document {
  const b64 = Buffer.from(innerSvgPayload).toString('base64');
  const html =
    '<!doctype html><html><body>' +
    '<body-content-section><div id="core">' +
    '<documentation-markdown><h2>Core</h2><p>Has diagram.</p></documentation-markdown>' +
    '<code-documentation-diagram-inline data-test-id="diagram-inline">' +
    '<code-documentation-diagram-contents>' +
    '<svg viewBox="0 0 100 100"><g>' +
    `<image width="100%" height="100%" href="data:image/svg+xml;base64,${b64}"/>` +
    '</g></svg>' +
    '</code-documentation-diagram-contents></code-documentation-diagram-inline>' +
    '</div></body-content-section>' +
    '</body></html>';
  return new JSDOM(html).window.document;
}

function buildEmptyWrapperDocument(): Document {
  // Outer <svg> with NO inner <image> and NO Graphviz markup. This is the
  // pure "drift" case — the warn-log should fire under condition (b).
  const html =
    '<!doctype html><html><body>' +
    '<body-content-section><div id="core">' +
    '<documentation-markdown><h2>Core</h2><p>Has diagram.</p></documentation-markdown>' +
    '<code-documentation-diagram-inline>' +
    '<svg viewBox="0 0 100 100"><g><text>just decorative</text></g></svg>' +
    '</code-documentation-diagram-inline>' +
    '</div></body-content-section>' +
    '</body></html>';
  return new JSDOM(html).window.document;
}

describe('extractFromDocument — diagram base64 SVG decode (v2.8)', () => {
  it('extracts diagram nodes from base64-embedded Graphviz SVG inside the outer <svg> wrapper', () => {
    const doc = buildProdShapeDocument(MINI_GRAPHVIZ_SVG);
    const result = extractFromDocument(doc);
    const diagrams = result.nodes.filter((n) => n.type === 'diagram') as DiagramNode[];
    expect(diagrams).toHaveLength(1);
    const d = diagrams[0];
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0]).toMatchObject({ from: 'n1', to: 'n2' });
    // svgBase64 must be preserved alongside the parsed structure for any
    // future renderer that wants the bytes.
    expect(d.svgBase64).toBeTruthy();
    // Mermaid is produced when the graph isn't lossy.
    expect(d.mermaid).toContain('flowchart TD');
  });

  it('falls back to outer SVG parsing when no <image> tag is present (synthetic-shape contract)', () => {
    // The pre-existing synthetic.html fixture already exercises this — it
    // contains inline <g class="node">/<g class="edge"> directly under
    // <svg> with no <image> wrapper. The earlier test
    // `extracts diagrams from <code-documentation-diagram-inline>` covers
    // it. Here we double-down on the contract.
    const result = extractFromDocument(loadFixture('synthetic.html'));
    const d = result.nodes.find((n) => n.type === 'diagram') as DiagramNode;
    expect(d.svgBase64).toBeUndefined();
    expect(d.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to outer SVG when base64 decode produces 0 nodes (defense path)', () => {
    // Inner image is present but the base64 decodes to an SVG without
    // Graphviz markup. Outer SVG also lacks Graphviz markup. Final
    // DiagramNode should still be returned (with empty nodes/edges) — the
    // warn-log fires under condition (a) and the extractor does NOT throw.
    const NON_GRAPHVIZ_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const doc = buildProdShapeDocument(NON_GRAPHVIZ_SVG);
    const result = extractFromDocument(doc);
    const d = result.nodes.find((n) => n.type === 'diagram') as DiagramNode;
    expect(d).toBeDefined();
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
    // svgBase64 is still preserved.
    expect(d.svgBase64).toBeTruthy();
  });

  it('produces an empty DiagramNode (no throw) when no <image> AND outer SVG has no Graphviz markup', () => {
    // Drift condition (b): both branches yield 0 nodes. Extractor must
    // not crash; DiagramNode is emitted with empty nodes/edges so
    // downstream code (chunker render fallback) still produces a chunk.
    const doc = buildEmptyWrapperDocument();
    const result = extractFromDocument(doc);
    const d = result.nodes.find((n) => n.type === 'diagram') as DiagramNode;
    expect(d).toBeDefined();
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
    expect(d.svgBase64).toBeUndefined();
  });
});
