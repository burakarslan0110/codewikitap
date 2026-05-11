/**
 * Internal Markdown rendering helpers — shared by serializer.ts (full-page
 * + footer rendering) and chunker.ts (per-section chunk text). Factored out
 * here so v2 reuse does not widen serializer.ts's public surface.
 *
 * @internal — do NOT import from outside src/extraction/. Public API for
 * canonical-tree → Markdown is `serialize()` in serializer.ts.
 */

import { CanonicalNode } from './canonical_tree.js';

/** Cheap, deterministic token estimate (~4 chars/token, English heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Render a single CanonicalNode to its Markdown projection. */
export function renderNode(n: CanonicalNode): string {
  switch (n.type) {
    case 'heading': {
      const hashes = '#'.repeat(n.level);
      return `${hashes} ${n.title}\n`;
    }
    case 'prose':
      return n.markdown.trim() + '\n';
    case 'code': {
      const lang = n.language ?? '';
      const fence = '```';
      const link = n.github
        ? `\n_Source: https://github.com/${n.github.repo}/blob/${n.github.sha}/${n.github.path}${n.github.lineRange ? '#' + n.github.lineRange : ''}_\n`
        : '';
      return `${fence}${lang}\n${n.text}\n${fence}${link}`;
    }
    case 'diagram': {
      if (n.mermaid && !n.lossy) {
        return '```mermaid\n' + n.mermaid + '\n```\n';
      }
      const nodesLine =
        n.nodes.length > 0
          ? '> nodes: ' + n.nodes.map((nd) => `${nd.id}=${JSON.stringify(nd.label)}`).join(', ')
          : '> nodes: (none)';
      const edgesLine =
        n.edges.length > 0
          ? '> edges: ' +
            n.edges.map((e) => `${e.from} -> ${e.to}${e.label ? ' [' + e.label + ']' : ''}`).join(', ')
          : '> edges: (none)';
      const lines = ['> Diagram (text fallback)', '>', nodesLine, edgesLine];
      if (n.sourceUrl) lines.push(`> view: ${n.sourceUrl}`);
      return lines.join('\n') + '\n';
    }
  }
}
