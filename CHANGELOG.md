# Changelog

All notable changes to **CodeWiKiTap** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-11

### Highlights

First public release on npm. Renamed from internal `@codewiki/mcp` to **`codewikitap`** (unscoped) for one-paste install (`npx codewikitap`). Ships polished brand assets, bilingual documentation (English + Turkish), Claude plugin marketplace integration, and a full release-engineering posture.

### Added

- **Brand identity** — Logo (`assets/logo.png`, 1024×1024 PNG generated via Canva). Clean horizontal "CodeWiKiTap" wordmark in a navy-blue tone, on transparent background. Embedded in both README hero blocks via absolute GitHub raw URL so it renders correctly on both the GitHub repo home and the npm package page.
- **Bilingual README** — `README.md` (English default; rendered on npm + GitHub) and `README.tr.md` (Turkish). Cross-linked via a language-switcher row at the top of both files. Logo references use absolute GitHub raw URLs so the hero block renders on both surfaces.
- **Self-hosted Claude plugin marketplace** — `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` at the repo root. Users can install via `/plugin marketplace add burakarslan0110/codewikitap` → `/plugin install codewikitap@burakarslan0110-codewikitap`. Marketplace `source` uses the `npm` form (auto-pins plugin version to npm publishes).
- **GitHub Actions CI/CD** — `.github/workflows/ci.yml` (lint + unit + integration + audit on every PR/push; Node 20, pnpm 10.33.4 pinned) and `.github/workflows/release.yml` (publish to npm + create GitHub Release on `v*` tag push, gated by `NPM_TOKEN` repo secret).
- **Pre-publish smoke test** — `scripts/verify-publish.mjs` runs `npm pack`, installs the tarball into a temp dir, asserts the file allowlist matches expectations, and confirms the `codewikitap` bin file is present + executable.
- **Release-hygiene files** — `LICENSE` (MIT; previously declared in `package.json` but the file itself was missing — publish blocker fixed), `CHANGELOG.md` (this file), `SECURITY.md` (disclosure policy + zero-telemetry statement), `CONTRIBUTING.md` (pnpm-only workflow, `/spec` convention, release process).
- **NPM metadata** — `author`, `homepage`, `bugs`, `repository` (with `git+` prefix and `.git` suffix per npm convention), expanded `keywords` (added `plugin`, `claude-plugin`, `plugin-marketplace`, `knowledge-graph`, `hybrid-retrieval`, `gemini-cli`).
- **`verify-publish` pnpm script** — invokes the smoke test.

### Changed

- **Renamed** the npm package: `@codewiki/mcp` → **`codewikitap`** (unscoped; verified FREE on npm pre-release). The previous scoped name was declared in `package.json` but never actually published.
- **Renamed** the bin command: `codewiki-mcp` → **`codewikitap`** so the install command matches the package name (`npx codewikitap`).
- **Renamed** the GitHub repository: `burakarslan0110/codewiki-mcp` → `burakarslan0110/codewikitap`. GitHub auto-redirects old URLs indefinitely — existing stars, forks, and links continue to work.
- **Updated** `package.json:files` allowlist to include `README.tr.md`, `assets/`, `.claude-plugin/`, and `.mcp.json`. Previous allowlist was `["dist", "README.md", "LICENSE"]`.
- **Promoted** `sqlite-vec` from `optionalDependencies` to `dependencies` in the v2.6 internal milestone (carried forward in this release). The pure-JS cosine fallback remains as a runtime fallback for environments where `db.loadExtension()` is denied (macOS System Integrity Protection, hardened sandboxes).

### Fixed

- **Stray duplicate** — `/2026-05-09-codewiki-mcp.md` at the repo root was a duplicate of an internal planning file. Deleted to clean the GitHub repo home view.
- **Missing LICENSE file** — `package.json:license` declared `MIT` but the LICENSE file did not exist at the repo root, so `npm pack` produced tarballs missing the legal text. Fixed by adding the SPDX MIT template at `LICENSE`.
- **ESLint coverage of `.mjs` scripts** — `eslint.config.js` `files` glob extended from `scripts/**/*.ts` to also include `scripts/**/*.mjs`, so `scripts/verify-publish.mjs` and other ESM scripts are now linted by `pnpm lint`. As a collateral fix, removed an obsolete `/* eslint-env node */` comment from `scripts/e2e-rerank-check.mjs` (it had been hiding behind the previous `.ts`-only glob; the comment is no longer recognized by ESLint flat config and was causing `no-redeclare` errors once the glob widened).

### Security

- Zero-telemetry posture explicitly documented in `SECURITY.md`. The MCP server transmits no user code, queries, or environment data to third parties. CodeWiki HTTPS calls are the only outbound traffic, governed by the existing 1-page-load-per-4-seconds-per-origin rate limit.
- Disclosure email: `burakarslan0110@gmail.com`.

### Known unverified items (v0.3.0)

- **Plugin install id format `codewikitap@burakarslan0110-codewikitap`** — documented in README install snippets per the Claude Code docs at `code.claude.com/docs/en/discover-plugins`, but not live-tested against a real Claude Code instance. Will be verified post-publish during the manual TS-005 walkthrough.
- **Codex adversarial review** — both planning-phase and verification-phase Codex review attempts hit the ChatGPT Plus rate limit (resets 2026-05-16). The Claude reviewer's verdict (compliance/quality/goal all high) is the authoritative signal for v0.3.0. Codex re-review tracked as a `Deferred Idea` in the plan; re-run after 2026-05-16 if any architectural risk surfaces in the wild.

---

## Pre-history (internal milestones, unpublished)

Internal-only development tracked across `/spec` plans (kept locally, not committed). Each milestone was a plan-approval-verify cycle. None were published to npm; the project debuted on the public registry at v0.3.0.

- **v1** (May 9, 2026) — Initial stdio MCP server. 5 read-only tools: `list_project_dependencies`, `resolve_repo`, `list_pages`, `get_page`. Three-layer cache. Playwright stealth. Citation footer.
- **v2** (May 10, 2026) — Added `find_chunks` (semantic retrieval). Local ONNX embeddings via `Xenova/bge-small-en-v1.5`. Heading-aware per-section chunking. Sub-section navigation in `get_page`.
- **v2.1** — Knowledge graph (`find_neighbors`). 5 typed edge kinds (`code_ref`, `diagram_edge`, `diagram_member`, `section_link`, `cross_repo_ref`) plus query-time `dep_link` derivation. No new model downloads.
- **v2.2** — Ecosystem coverage: Rust (Cargo), PHP (Composer), Python (Poetry). chokidar manifest watcher.
- **v2.3** — Ecosystem coverage II: Java (Maven), Ruby, .NET (csproj + CPM), JS workspaces, Cargo glob.
- **v2.4** — Full Maven hardening (property resolution + BOM imports + aggregator-pom traversal), `*.sln` discovery, `go.work` workspaces, Gradle subprojects.
- **v2.5** — Maven `<parent>` POM resolution + recursive BOM walk, Gradle DSL parsing, plugin-id → Maven coord map, embedder model-swap auto-reindex, stderr metrics, pagination, `find_neighbors` semantic ranking.
- **v2.6** — `sqlite-vec` activated as a hard runtime dep (parallel `vec_chunks` virtual table). Always-on cross-encoder reranker (`Xenova/ms-marco-MiniLM-L-6-v2`). 7th MCP tool: `request_indexing` (first non-readonly).
- **v2.7** — Hybrid retrieval: BM25 (FTS5) + vector merged via Reciprocal Rank Fusion (RRF k=60). New per-chunk audit fields. Eval baseline (`tests/eval/baseline-v2.7-hybrid.json`).
- **v2.8** — Startup auto-prewarm (eagerly index direct deps that have CodeWiki coverage). `optionalDependencies` support. `no_wiki` lean envelope.

---

[Unreleased]: https://github.com/burakarslan0110/codewikitap/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/burakarslan0110/codewikitap/releases/tag/v0.3.0
