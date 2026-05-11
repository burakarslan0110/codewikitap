/**
 * CodeWiki DOM → canonical tree extractor.
 *
 * `extractFromDocument(doc)` operates on any DOM `Document` — a real browser
 * page (when called via `extractFromPage(page)`) OR a JSDOM-loaded fixture
 * (in unit tests). The implementation uses only standard DOM APIs that both
 * environments implement.
 *
 * Design contract: do not anchor on Angular's transient `_ngcontent-*`
 * attributes — they change on every build. Anchor on stable web-component
 * tag names and `data-test-id` markers.
 */

import TurndownService from 'turndown';
import type { Page } from 'playwright';

import {
  CanonicalNode,
  CodeNode,
  DiagramNode,
  ExtractionResult,
  HeadingNode,
  ProseNode,
  inferParentSlug,
} from './canonical_tree.js';
import { convertGraphvizSvg } from './diagram_converter.js';
import { getLogger } from '../logging.js';

const GITHUB_LINK_REGEX =
  /https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/([0-9a-f]{40})\/([^\s#"']+)(?:#(L\d+(?:-L\d+)?))?/;

const NOT_FOUND_HINTS = [
  "we couldn't find that page",
  'we could not find that page',
  'page not found',
  "this page doesn't exist",
  'this page does not exist',
];

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

export async function extractFromPage(page: Page): Promise<ExtractionResult> {
  // For Playwright pages, hand the rendered HTML to a JSDOM-backed extractor
  // server-side. Doing the work in `page.evaluate()` would force us to
  // serialise turndown + the diagram converter as strings; rendering the
  // current DOM and running the same code path keeps a single source of truth.
  const html = await page.content();
  const { JSDOM } = await import('jsdom');
  const doc = new JSDOM(html).window.document;
  return extractFromDocument(doc);
}

export function extractFromDocument(doc: Document): ExtractionResult {
  // Fast-path: explicit not-found page detection.
  //
  // Structural signals first — stable web-component tag + class string emitted
  // by CodeWiki's not-found Angular route. These survive copy rewrites; the
  // text hints below are kept as a belt-and-suspenders fallback for older
  // shells and synthetic fixtures.
  if (
    doc.querySelector('app-not-found') !== null ||
    doc.querySelector('.page-not-found, [class*="page-not-found"]') !== null
  ) {
    return { nodes: [], notFound: true, firstCommitSha: null, emptyShell: false };
  }
  const bodyText = (doc.body?.textContent ?? '').toLowerCase();
  if (NOT_FOUND_HINTS.some((h) => bodyText.includes(h))) {
    return { nodes: [], notFound: true, firstCommitSha: null, emptyShell: false };
  }

  const sections = Array.from(doc.querySelectorAll('body-content-section'));
  if (sections.length === 0) {
    // ⛔ Codex finding: an empty SPA shell (no sections AND no explicit
    // not-found marker) is NOT a confirmed no-docs result — it could be a
    // bot challenge, DOM drift, or a partial render. The caller MUST treat
    // this as transient/retry, NEVER cache as `hasWiki=false`.
    return { nodes: [], notFound: false, firstCommitSha: null, emptyShell: true };
  }

  // First pass: collect all section slugs so parentSlug inference has the
  // full set up front.
  const slugs = new Set<string>();
  const sectionMeta: Array<{ slug: string; section: Element; level: 1 | 2 | 3 | 4; title: string }> = [];

  for (const section of sections) {
    const slugDiv = section.querySelector('div[id]');
    if (!slugDiv) continue;
    const slug = slugDiv.getAttribute('id') ?? '';
    if (!slug) continue;
    slugs.add(slug);
    const headingEl = section.querySelector('h1, h2, h3, h4');
    const tagName = headingEl?.tagName?.toLowerCase() ?? 'h2';
    const level = (Number(tagName.replace('h', '')) || 2) as 1 | 2 | 3 | 4;
    const title = headingEl?.textContent?.trim() ?? slug;
    sectionMeta.push({ slug, section, level, title });
  }

  const nodes: CanonicalNode[] = [];
  let firstCommitSha: string | null = null;

  for (const meta of sectionMeta) {
    const parentSlug = inferParentSlug(meta.slug, slugs);
    const hasDiagrams = meta.section.querySelector('code-documentation-diagram-inline') !== null;

    const heading: HeadingNode = {
      type: 'heading',
      sectionSlug: meta.slug,
      slug: meta.slug,
      title: meta.title,
      level: meta.level,
      parentSlug,
      hasDiagrams,
    };
    nodes.push(heading);

    // For each <documentation-markdown> in the section, emit one ProseNode +
    // any code blocks found inside.
    const markdownRoots = meta.section.querySelectorAll('documentation-markdown');
    for (const root of Array.from(markdownRoots)) {
      // Strip code blocks from the markdown root before turndown so they
      // become CodeNodes (with structured github linkage), not embedded
      // fenced blocks in the prose.
      const codeBlocks = Array.from(root.querySelectorAll('pre'));
      const proseRoot = root.cloneNode(true) as Element;
      for (const pre of Array.from(proseRoot.querySelectorAll('pre'))) {
        pre.remove();
      }
      // Drop the heading itself from the prose (it's already on the HeadingNode).
      const headingInProse = proseRoot.querySelector('h1, h2, h3, h4');
      headingInProse?.remove();

      const html = (proseRoot.innerHTML ?? '').trim();
      if (html.length > 0) {
        const markdown = turndown.turndown(html).trim();
        if (markdown.length > 0) {
          const prose: ProseNode = { type: 'prose', sectionSlug: meta.slug, markdown };
          nodes.push(prose);
        }
      }

      for (const pre of codeBlocks) {
        const codeEl = pre.querySelector('code');
        const text = (codeEl?.textContent ?? pre.textContent ?? '').trimEnd();
        const language = extractLanguage(codeEl ?? pre);
        const github = extractGithubLink(pre, root);
        if (github && firstCommitSha === null) firstCommitSha = github.sha;
        const code: CodeNode = {
          type: 'code',
          sectionSlug: meta.slug,
          language,
          text,
          ...(github ? { github } : {}),
        };
        nodes.push(code);
      }
    }

    // Diagrams are extracted separately because they live OUTSIDE
    // <documentation-markdown> in the CodeWiki DOM.
    const diagramRoots = meta.section.querySelectorAll('code-documentation-diagram-inline');
    for (const diag of Array.from(diagramRoots)) {
      const svgEl = diag.querySelector('svg');
      const node: DiagramNode = {
        type: 'diagram',
        sectionSlug: meta.slug,
        nodes: [],
        edges: [],
        lossy: false,
      };
      if (svgEl) {
        // v2.8: production CodeWiki wraps the real Graphviz SVG as a
        // base64-encoded `<image>` inside the outer `<svg>` viewport.
        // Pre-v2.8 the extractor ran `convertGraphvizSvg` against the
        // wrapper (no g.node/g.edge classes), silently producing empty
        // DiagramNodes. The decode path takes precedence; the outer-SVG
        // path is the fallback that preserves the synthetic.html contract.
        const innerImage = svgEl.querySelector(
          'image[href^="data:image/svg+xml;base64,"]',
        );
        // Three distinguishable b64 outcomes so operators can tell apart
        // "decode threw" (malformed base64) from "decoded successfully but
        // not Graphviz" (e.g. raster <image>) when the warn-log fires.
        let decodeError: string | null = null;
        let decodedNodeCount = 0;
        if (innerImage) {
          const href = innerImage.getAttribute('href') ?? '';
          const b64 = href.replace(/^data:image\/svg\+xml;base64,/, '');
          if (b64) node.svgBase64 = b64;
          try {
            const decoded = Buffer.from(b64, 'base64').toString('utf8');
            const fromB64 = convertGraphvizSvg(decoded);
            decodedNodeCount = fromB64.nodes.length;
            if (fromB64.nodes.length > 0) {
              node.nodes = fromB64.nodes;
              node.edges = fromB64.edges;
              node.lossy = fromB64.lossy;
              if (fromB64.mermaid) node.mermaid = fromB64.mermaid;
            }
          } catch (err) {
            decodeError = err instanceof Error ? err.message : String(err);
            getLogger().warn('extractor.diagram_b64_decode_failed', {
              sectionSlug: meta.slug,
              reason: decodeError,
            });
          }
        }
        // Fallback to outer SVG when the decode path didn't yield nodes
        // (covers synthetic.html-style fixtures and any future shape with
        // inline `g.node`/`g.edge` on the outer wrapper).
        let outerSvgNodeCount = 0;
        if (decodedNodeCount === 0) {
          const fromOuter = convertGraphvizSvg(svgEl.outerHTML);
          outerSvgNodeCount = fromOuter.nodes.length;
          if (fromOuter.nodes.length > 0) {
            node.nodes = fromOuter.nodes;
            node.edges = fromOuter.edges;
            node.lossy = fromOuter.lossy;
            if (fromOuter.mermaid) node.mermaid = fromOuter.mermaid;
          }
        }
        // Drift-detection warn-log: fires when (a) an inner <image> was
        // present but the final result is still empty (production Angular
        // drift signal), or (b) no inner <image> AND outer SVG yielded
        // 0 nodes. Payload distinguishes decode-threw vs decoded-empty so
        // operators can tell whether base64 was malformed or the inner
        // SVG just wasn't Graphviz.
        if (node.nodes.length === 0) {
          getLogger().warn('extractor.diagram_empty', {
            sectionSlug: meta.slug,
            hasInnerImage: innerImage !== null,
            decodeError,
            decodedNodeCount,
            outerSvgNodeCount,
          });
        }
      } else {
        // Embedded base64 image variant — no outer <svg> wrapper. Kept
        // for safety; production always wraps in <svg> per captured
        // fixtures (react.html: 71/71 diagrams).
        const imageEl = diag.querySelector('image[href^="data:image/svg+xml;base64,"]');
        const href = imageEl?.getAttribute('href') ?? '';
        const b64 = href.replace(/^data:image\/svg\+xml;base64,/, '');
        if (b64) node.svgBase64 = b64;
      }
      nodes.push(node);
    }

    if (firstCommitSha === null) {
      // Also look at links in prose markdown for a SHA.
      const anyLink = meta.section.querySelector('a[href*="/blob/"]');
      const href = anyLink?.getAttribute('href') ?? '';
      const m = GITHUB_LINK_REGEX.exec(href);
      if (m) firstCommitSha = m[2];
    }
  }

  return { nodes, notFound: false, firstCommitSha, emptyShell: false };
}

function extractLanguage(el: Element): string | undefined {
  const cls = el.getAttribute('class') ?? '';
  // Common patterns: `language-ts`, `lang-ts`, `hljs ts`.
  const langMatch = /(?:^|\s)(?:language-|lang-)([A-Za-z0-9_-]+)/.exec(cls);
  if (langMatch) return langMatch[1];
  return undefined;
}

function extractGithubLink(pre: Element, root: Element): CodeNode['github'] | undefined {
  // Search the pre block first for an embedded link, then fall back to any
  // github.com/.../blob/<sha>/... link in the surrounding markdown root.
  const candidates: Element[] = [];
  candidates.push(...Array.from(pre.querySelectorAll('a[href*="github.com"]')));
  if (candidates.length === 0) {
    candidates.push(...Array.from(root.querySelectorAll('a[href*="github.com"]')));
  }
  for (const a of candidates) {
    const href = a.getAttribute('href') ?? '';
    const m = GITHUB_LINK_REGEX.exec(href);
    if (m) {
      const [, repo, sha, p, range] = m;
      return { repo, sha, path: p, lineRange: range };
    }
  }
  return undefined;
}
