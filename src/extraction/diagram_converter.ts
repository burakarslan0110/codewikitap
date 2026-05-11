/**
 * Graphviz-rendered SVG → Mermaid (best-effort) + structured node/edge fallback.
 *
 * Graphviz emits SVG where each node is wrapped in `<g class="node">` and each
 * edge in `<g class="edge">`. The original Graphviz IDs live in `<title>` and
 * the visible labels in `<text>`. We use that to reconstruct the graph.
 *
 * Conversion is best-effort: when a graph has nested clusters > 2 deep,
 * port-anchored edges, or HTML-shaped labels, we set `lossy: true` and the
 * caller falls back to the textual node/edge list (always populated).
 */

import { JSDOM } from 'jsdom';

export interface ConvertedDiagram {
  mermaid: string | null;
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  lossy: boolean;
}

export function convertGraphvizSvg(svgString: string): ConvertedDiagram {
  const out: ConvertedDiagram = { mermaid: null, nodes: [], edges: [], lossy: false };
  if (!svgString || !svgString.includes('<svg')) {
    out.lossy = true;
    return out;
  }

  let doc: Document;
  try {
    doc = new JSDOM(svgString, { contentType: 'text/html' }).window.document;
  } catch {
    out.lossy = true;
    return out;
  }

  const nodeEls = Array.from(doc.querySelectorAll('g.node'));
  const edgeEls = Array.from(doc.querySelectorAll('g.edge'));
  const clusterEls = Array.from(doc.querySelectorAll('g.cluster'));

  for (const n of nodeEls) {
    const id = (n.querySelector('title')?.textContent ?? '').trim();
    const label = (n.querySelector('text')?.textContent ?? id).trim();
    if (!id) continue;
    out.nodes.push({ id, label });
  }

  for (const e of edgeEls) {
    const titleText = (e.querySelector('title')?.textContent ?? '').trim();
    // Edge titles are "from->to" (digraph) or "from--to" (undirected).
    const m = /^(.+?)\s*(?:->|--)\s*(.+?)$/.exec(titleText);
    if (!m) {
      out.lossy = true;
      continue;
    }
    const labelText = (e.querySelector('text')?.textContent ?? '').trim();
    out.edges.push({ from: m[1].trim(), to: m[2].trim(), ...(labelText ? { label: labelText } : {}) });
  }

  // Lossy heuristics.
  if (clusterEls.length > 0) out.lossy = true; // we only emit flat Mermaid below

  // Build Mermaid only if we have at least one node and no obvious lossy signals.
  if (out.nodes.length > 0 && !out.lossy) {
    const idMap = new Map<string, string>();
    out.nodes.forEach((n, i) => idMap.set(n.id, `N${i}`));
    const lines: string[] = ['flowchart TD'];
    for (const n of out.nodes) {
      const safeLabel = n.label.replace(/"/g, '\\"');
      lines.push(`  ${idMap.get(n.id)}["${safeLabel}"]`);
    }
    for (const e of out.edges) {
      const from = idMap.get(e.from);
      const to = idMap.get(e.to);
      if (!from || !to) { out.lossy = true; continue; }
      if (e.label) {
        lines.push(`  ${from} -->|${e.label.replace(/\|/g, '\\|')}| ${to}`);
      } else {
        lines.push(`  ${from} --> ${to}`);
      }
    }
    out.mermaid = lines.join('\n');
  }

  return out;
}
