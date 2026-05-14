/**
 * Shared type definitions for the CodeWiki MCP server.
 * The CanonicalNode tree types live in `src/extraction/canonical_tree.ts`
 * (the v1 ↔ v2 contract); other shared shapes live here.
 */

export type Ecosystem = 'npm' | 'pypi' | 'go' | 'cargo' | 'composer' | 'maven' | 'gem' | 'nuget';

export interface Dependency {
  name: string;
  ecosystem: Ecosystem;
  declaredVersion?: string;
  /** v2.2: dependency group classification. Undefined = treat as 'runtime' (back-compat). */
  kind?: 'runtime' | 'dev' | 'optional';
}

export type RepoSource = 'npm-registry' | 'pypi' | 'go-proxy' | 'go-vanity' | 'fuzzy' | 'crates-io' | 'packagist' | 'maven-central' | 'rubygems' | 'nuget';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * v0.6: detected framework attached to a `ProjectScan` by `detectFrameworks`.
 * The agent uses this as a structured shortcut — `sourceRepo` is the GitHub
 * `owner/repo` slug for which to call `request_indexing` / `get_page` /
 * `find_chunks`.
 *
 * Confidence semantics:
 *   - 'high'   = the framework runtime entry itself (next, django,
 *                spring-boot-starter-*, @angular/core). Import implies use.
 *   - 'medium' = framework-adjacent core runtime that is NOT framework-
 *                defining on its own (tokio runtime, axios, undici).
 *   - 'low'    = reserved for pattern-based fuzzy match. Unused in v0.6.
 */
export interface FrameworkContext {
  name: string;
  confidence: Confidence;
  /** GitHub `owner/repo` for `request_indexing` / `get_page`. */
  sourceRepo: string;
  /** Where it was found, e.g. `package.json:dependencies.next`. */
  detectedFrom: string;
}

export interface ResolvedRepo {
  owner: string;
  repo: string;
  source: RepoSource;
  confidence: Confidence;
  alternates?: Array<{ owner: string; repo: string; source: RepoSource }>;
}

export type ManifestType =
  | 'package.json'
  | 'requirements.txt'
  | 'pyproject.toml'
  | 'go.mod'
  | 'Cargo.toml'
  | 'composer.json'
  | 'pom.xml'
  | 'libs.versions.toml'
  | 'Gemfile'
  | 'Gemfile.lock'
  | 'csproj'
  | 'Directory.Packages.props'
  | 'sln'
  | 'go.work'
  | 'settings.gradle';

/**
 * v2.4: a `<scope>import</scope>` BOM dependency declared in
 * <dependencyManagement>. Surfaced as a side-channel from the parser; the
 * tool layer's `enrichWithBomImports` fetches the BOM POM and patches
 * unset `Dependency.declaredVersion` entries.
 */
export interface BomImport {
  groupId: string;
  artifactId: string;
  version: string;
}

/**
 * v2.5: Maven `<parent>` coordinates extracted from a child pom's `<parent>`
 * element. Surfaced as a side-channel from `extractParentCoords`; the tool
 * layer's `enrichWithParentPom` fetches the parent POM, patches unset
 * `Dependency.declaredVersion` entries from the parent's literal
 * `<dependencyManagement>`, and APPENDS the parent's nested
 * `<scope>import</scope>` BOMs onto `scan.bomImports` so the recursive BOM
 * walker resolves them at depth 0 alongside the child's own BOMs.
 */
export interface ParentCoords {
  groupId: string;
  artifactId: string;
  version: string;
}

export interface ProjectScan {
  projectRoot: string | null;
  manifestType: ManifestType | null;
  dependencies: Dependency[];
  /** v2.2: populated only when scan walked into workspace members (Cargo or JS). Carries member DIRECTORIES; the watcher derives the manifest filename per ecosystem. */
  workspaceMembers?: string[];
  /** v2.3: absolute path of the manifest the scanner actually opened. Set for glob-discovered (`csproj`) and nested-path (`gradle/libs.versions.toml`) manifests so the watcher anchors on the right file. */
  matchedManifestPath?: string;
  /** v2.3: additional file paths the watcher must observe verbatim — e.g., extra `*.csproj` matches in the same dir, `Directory.Packages.props` discovered via the upward CPM walk, `pnpm-workspace.yaml`. NEVER carries member directories (those go in `workspaceMembers`). */
  extraManifestFiles?: string[];
  /** v2.4: Maven `<scope>import</scope>` BOM imports detected by `parsePomXml` (only set for `pom.xml` manifests). The tool layer resolves these via Maven Central in `enrichWithBomImports`. */
  bomImports?: BomImport[];
  /** v2.5: Maven `<parent>` coordinates extracted from the child pom's `<parent>` element. The tool layer fetches the parent POM in `enrichWithParentPom` BEFORE bom enrichment runs. */
  parentCoords?: ParentCoords;
}

export interface PageIndexEntry {
  slug: string;
  title: string;
  level: 1 | 2 | 3 | 4;
  parentSlug: string | null;
  hasDiagrams: boolean;
}

export interface Citation {
  sourceUrl: string;
  commitSha: string;
  lastChecked: string; // ISO 8601 timestamp
}

export type FallbackKind = 'github_readme' | 'request_indexing';

export interface Fallback {
  kind: FallbackKind;
  url: string;
  label?: string;
}

// ---------------------------------------------------------------------------
// v2 RAG types — additive, no v1 type changes.
// ---------------------------------------------------------------------------

import type { GithubLink } from './extraction/canonical_tree.js';

/**
 * A chunk of canonical-tree content ready to embed and index.
 * `pageSlug` is always `'__root__'` in v2 (CodeWiki publishes one document
 * per repo); kept as a column for forward compat with hypothetical multi-doc.
 */
export interface Chunk {
  repo: string;
  pageSlug: string;
  sectionSlug: string;
  ordinal: number;
  text: string;
  github?: GithubLink;
}

/** A Chunk after it has been embedded and tagged with freshness anchor. */
export interface IndexedChunk extends Chunk {
  embedding: Float32Array;
  indexedAt: number;
  commitSha: string;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export type CodeWikiErrorKind =
  | 'no_docs'
  | 'codewiki_dom_changed'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'playwright_unavailable';

export class CodeWikiError extends Error {
  readonly kind: CodeWikiErrorKind;
  readonly retryAfterSeconds?: number;

  constructor(kind: CodeWikiErrorKind, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = 'CodeWikiError';
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * RC2 (MCP -32000 reconnect fix): Playwright's `chromium-headless-shell`
 * binary is missing or the parallel `ensurePlaywright` install is still
 * in flight / has rejected. Browser-dependent tools (`get_page`,
 * `list_pages`, `find_chunks` cache-miss, `find_neighbors` cache-miss,
 * `request_indexing`) surface this; non-browser tools
 * (`list_project_dependencies`, `resolve_repo`) are unaffected. The
 * `codewiki_client.defaultFetchPage` boundary catches this and remaps it
 * to `CodeWikiError('rate_limited', ..., retryAfterSeconds: 30)` so the
 * existing tool envelopes already know how to respond.
 */
export class PlaywrightUnavailableError extends CodeWikiError {
  constructor(message: string, retryAfterSeconds: number = 30) {
    super('playwright_unavailable', message, retryAfterSeconds);
    this.name = 'PlaywrightUnavailableError';
  }
}

export type ManifestErrorKind =
  | 'unsafe_manifest'
  | 'manifest_too_large'
  | 'invalid_encoding'
  | 'parse_error'
  | 'unsupported_format';

export class ManifestError extends Error {
  readonly kind: ManifestErrorKind;
  readonly path?: string;

  constructor(kind: ManifestErrorKind, message: string, path?: string) {
    super(message);
    this.name = 'ManifestError';
    this.kind = kind;
    this.path = path;
  }
}

export type RepoResolveErrorKind = 'upstream_unavailable' | 'malformed_response';

export class RepoResolveError extends Error {
  readonly kind: RepoResolveErrorKind;
  readonly query?: string;

  constructor(kind: RepoResolveErrorKind, message: string, query?: string) {
    super(message);
    this.name = 'RepoResolveError';
    this.kind = kind;
    this.query = query;
  }
}

export type EmbedderErrorKind = 'download_failed' | 'encode_failed' | 'dim_mismatch';

export class EmbedderError extends Error {
  readonly kind: EmbedderErrorKind;

  constructor(kind: EmbedderErrorKind, message: string) {
    super(message);
    this.name = 'EmbedderError';
    this.kind = kind;
  }
}

/**
 * v2.6: cross-encoder reranker errors. Mirrors EmbedderError shape with
 * an extra `download_timeout` kind for the bounded model-load race.
 */
export type RerankerErrorKind = 'download_failed' | 'download_timeout' | 'score_failed';

export class RerankerError extends Error {
  readonly kind: RerankerErrorKind;

  constructor(kind: RerankerErrorKind, message: string) {
    super(message);
    this.name = 'RerankerError';
    this.kind = kind;
  }
}

/**
 * PSF-004 (Task 6): serializer-level guard against emitting a citation
 * footer with an invalid commitSha. The byte-equal CITATION_FOOTER_REGEX
 * requires a 40-char hex SHA; an empty/malformed value would silently
 * render `pinned to commit . AI-generated...` and break the contract.
 * The serializer throws SerializerError before constructing the footer
 * string so no broken bytes reach stdout.
 */
export type SerializerErrorKind = 'invalid_commit_sha';

export class SerializerError extends Error {
  readonly kind: SerializerErrorKind;

  constructor(kind: SerializerErrorKind, message: string) {
    super(message);
    this.name = 'SerializerError';
    this.kind = kind;
  }
}

/**
 * PSF-004 (Task 6): retriever-level defense-in-depth for the same
 * invariant. When stored chunks from a pre-fix build carry an empty
 * commitSha, the retriever maps the error to a structured `status:
 * 'retry'` envelope so clients see a recoverable failure instead of an
 * exception escaping the tool boundary.
 */
export type RetrieverErrorKind = 'empty_commit_sha';

export class RetrieverError extends Error {
  readonly kind: RetrieverErrorKind;

  constructor(kind: RetrieverErrorKind, message: string) {
    super(message);
    this.name = 'RetrieverError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// v2.1 Knowledge Graph types — additive, no v1/v2 changes.
// ---------------------------------------------------------------------------

export type KgNodeKind = 'section' | 'file' | 'diagram_node' | 'repo';

export type KgEdgeType =
  | 'code_ref'
  | 'diagram_edge'
  | 'diagram_member'
  | 'section_link'
  | 'cross_repo_ref';

/**
 * A reference to a node in the knowledge graph.
 * `id` follows the canonical conventions documented in
 * `.claude/rules/codewiki-mcp-knowledge-graph.md`:
 *   - section:      `<owner>/<repo>#<sectionSlug>`
 *   - file:         `<owner>/<repo>:<path>`
 *   - diagram_node: `<owner>/<repo>#<sectionSlug>::<nodeId>`
 *   - repo:         `<owner>/<repo>`
 */
export interface KgNodeRef {
  kind: KgNodeKind;
  id: string;
  label?: string;
}

/**
 * A directed edge in the knowledge graph.
 * `repo` is the OWNING CodeWiki repo from which this edge was extracted —
 * it is the freshness-key, NOT necessarily the repo of either endpoint.
 */
export interface KgEdge {
  srcKind: KgNodeKind;
  srcId: string;
  dstKind: KgNodeKind;
  dstId: string;
  edgeType: KgEdgeType;
  repo: string;
  metadata?: Record<string, unknown>;
  commitSha: string;
  indexedAt: number;
}

export type GraphIndexerErrorKind = 'extract_failed' | 'persist_failed';

export class GraphIndexerError extends Error {
  readonly kind: GraphIndexerErrorKind;

  constructor(kind: GraphIndexerErrorKind, message: string) {
    super(message);
    this.name = 'GraphIndexerError';
    this.kind = kind;
  }
}
