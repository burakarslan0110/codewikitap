import { describe, it, expect } from 'vitest';

import { convertGraphvizSvg } from '../../../src/extraction/diagram_converter.js';

const SIMPLE_3_NODE_SVG = `
<svg viewBox="0 0 100 100">
  <g class="node"><title>Start</title><text>Start</text></g>
  <g class="node"><title>Middle</title><text>Middle</text></g>
  <g class="node"><title>End</title><text>End</text></g>
  <g class="edge"><title>Start-&gt;Middle</title></g>
  <g class="edge"><title>Middle-&gt;End</title></g>
</svg>`;

const EDGE_LABEL_SVG = `
<svg>
  <g class="node"><title>A</title><text>A</text></g>
  <g class="node"><title>B</title><text>B</text></g>
  <g class="edge"><title>A-&gt;B</title><text>passes data</text></g>
</svg>`;

const CLUSTER_SVG = `
<svg>
  <g class="cluster"><title>cluster_outer</title></g>
  <g class="node"><title>x</title><text>X</text></g>
  <g class="node"><title>y</title><text>Y</text></g>
  <g class="edge"><title>x-&gt;y</title></g>
</svg>`;

describe('convertGraphvizSvg', () => {
  it('converts a simple 3-node graph to Mermaid flowchart TD', () => {
    const r = convertGraphvizSvg(SIMPLE_3_NODE_SVG);
    expect(r.lossy).toBe(false);
    expect(r.mermaid).toBeTruthy();
    expect(r.mermaid).toMatch(/^flowchart TD/);
    expect(r.mermaid).toContain('"Start"');
    expect(r.mermaid).toContain('"End"');
    expect(r.mermaid).toMatch(/N\d+ --> N\d+/);
  });

  it('preserves edge labels in the Mermaid output', () => {
    const r = convertGraphvizSvg(EDGE_LABEL_SVG);
    expect(r.mermaid).toContain('-->|passes data|');
    const e = r.edges[0];
    expect(e.label).toBe('passes data');
  });

  it('marks output lossy when clusters are present (flat Mermaid only in v1)', () => {
    const r = convertGraphvizSvg(CLUSTER_SVG);
    expect(r.lossy).toBe(true);
    // Mermaid is null when lossy.
    expect(r.mermaid).toBeNull();
    // Fallback nodes/edges remain populated.
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['x', 'y']);
    expect(r.edges).toHaveLength(1);
  });

  it('returns lossy:true with empty mermaid for non-svg input', () => {
    const r = convertGraphvizSvg('not an svg at all');
    expect(r.lossy).toBe(true);
    expect(r.mermaid).toBeNull();
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });

  it('always populates nodes/edges fallback regardless of Mermaid success', () => {
    const r = convertGraphvizSvg(SIMPLE_3_NODE_SVG);
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['End', 'Middle', 'Start']);
    expect(r.edges).toHaveLength(2);
    expect(r.edges[0]).toEqual({ from: 'Start', to: 'Middle' });
  });
});
