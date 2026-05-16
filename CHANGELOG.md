# Changelog

All notable changes to **CodeWiKiTap** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-05-16

### BREAKING

- **`request_indexing` tool removed.** Its behavior is now reachable via `get_page({ repo, prepareOnly: true })` — same envelope shape (`{ status: 'ready' | 'index_building' | 'no_docs' | 'rate_limited' | 'retry', chunkCount?, edgeCount?, fallbacks?, retryAfterSeconds?, reason? }`), same sync race against `INDEX_BUILD_TIMEOUT_MS`, same single-flight + TTL idempotency. Agents migrating need one client-config edit: change the tool name and add the `prepareOnly: true` argument. The advertised tool surface is now exactly **5 names** (`list_project_dependencies`, `resolve_repo`, `get_page`, `find_chunks`, `find_neighbors`).
- **`get_page` annotations flip to `readOnlyHint: false`.** The `prepareOnly: true` branch performs an HTTP fetch + sqlite write, so the tool is no longer read-only. `idempotentHint: true` remains thanks to the Indexer's single-flight + TTL contract.

### Changed

- **Default Node old-space heap capped at 1.5 GB via self-reexec.** The bin entry now checks `process.execArgv` at startup and, when `--max-old-space-size` is absent, re-execs itself with `--max-old-space-size=1536`. This stops the Linux OOM-killer from SIGKILL'ing the server child on 7.5 GB / 2 GB-swap hosts under repeated `find_chunks` load (5 SIGKILL events / 15 min observed in v0.6.1 test harness). Wrapper PID exits immediately when the child exits — two PIDs are transient. Operator escape hatches:
  - `CODEWIKI_NODE_HEAP_MB=<n>` — override the default cap.
  - `CODEWIKI_DISABLE_HEAP_CAP=1` — skip the wrapper entirely (full rollback).
  - The wrapper also sets a `CODEWIKI_HEAP_CAP_APPLIED=1` sentinel env var on the child as a fork-bomb guard against launchers that sanitize `execArgv` between wrapper and child.
- **`SERVER_INSTRUCTIONS` rewritten as a decision table.** The narrative paragraph that used to mention every tool has been replaced with a `When → Tool` table that names `find_chunks` as the first-resort retrieval tool and explicitly demotes `prepareOnly` to "only when find_chunks's automatic indexing isn't fast enough." `Indexer.__test_seedRecentBuildMs` (a test-only method on a production class) replaced with a constructor-injected `seedRecentBuildMs?: readonly number[]` option.

### Added

- **`runtime_heartbeat` metric** — emitted on stderr every 30 seconds carrying `rssMb`, `uptimeSec`, and `inFlightToolCount`. Post-mortem analysis of `-32000` disconnects now has telemetry beyond "the process is gone." Kill switch: `CODEWIKI_DISABLE_HEARTBEAT=1`. Tunable interval: `CODEWIKI_HEARTBEAT_INTERVAL_MS` (default 30000). Uses `setInterval(...).unref()` so the loop never holds the event loop alive past shutdown.
- **Windows graceful-shutdown bridge.** Windows lacks POSIX signal delivery — `child.kill('SIGTERM')` from the heap-cap wrapper is abrupt and the child's `process.on('SIGTERM', closer)` handler never runs. The wrapper now opens a 4th-stdio-fd IPC channel when `process.platform === 'win32'` and sends `{ type: 'codewiki-shutdown', signal }`; the child has a `process.on('message', ...)` listener that runs the same `closer()` path (cache + driver + watcher tear-down). 5 s grace window before force-kill. POSIX hosts are unchanged — direct `child.kill(sig)` is graceful and faster. SIGHUP is now only registered on POSIX (Windows has no SIGHUP).
- **Per-PID RSS measurement variant for TS-007** — `tests/integration/perf_spawned.integration.test.ts` spawns the real `dist/index.js` and reads `/proc/<child.pid>/status:VmRSS` directly, closing the InMemoryTransport variant's "test-runner RSS contamination" gap (Linux-only; macOS/Windows fall back to the cross-platform InMemoryTransport variant). The spawned child uses three env-gated test seams (below) to short-circuit Playwright / embedder / reranker model loads.
- **Test-mode env seams** (production code clearly env-gated; documented as test-only):
  - `CODEWIKI_TEST_FIXTURE_DIR=<path>` — `CodeWikiClient.defaultFetchPage` reads `<path>/<repo-with-slashes-as-double-underscore>.json` (an `ExtractionResult` JSON) instead of using Playwright. Used by the spawned-child perf harness.
  - `CODEWIKI_TEST_STUB_EMBEDDER=1` — `Embedder.resolveEncoder` returns a stub that emits deterministic L2-normalized unit vectors without loading `@xenova/transformers`.
  - `CODEWIKI_TEST_STUB_RERANKER=1` — `Reranker.resolveScorer` returns a stub that emits monotonic decreasing scores without loading the cross-encoder model.
- **`get_page` mutex validation** — calling with `prepareOnly: true` AND `listPages: true` now throws (MCP SDK translates to `isError: true` with a clear message). Earlier code silently preferred prepareOnly over listPages, which hid agent bugs.
- **`runtime.execArgv` info log** — emitted once at `server-ready` so the active heap cap is visible in `server.log` for forensics.
- **In-repo perf integration harness** — `tests/integration/perf.integration.test.ts` exercises TS-006 (50× concurrent `find_chunks`), TS-007 (10× cache reset+rebuild RSS-stable), and TS-008 (mixed 100-call workload at concurrency=8). Stress latency assertions skipped on CI (`it.skipIf(CI)`); correctness portions always run. Run locally with `pnpm run test:perf` before tagging a release.
- **`test:perf` npm script** alongside `test`, `test:integration`, `test:all`, `audit`.

### Fixed

- **OOM-killer disconnect cycle.** v0.6.1 was observed taking 5 SIGKILL events on a 7.5 GB / 2 GB-swap host within a 15-minute test run; the heap cap (above) plus the existing `quantized: true` loads for the embedder + reranker keep RSS comfortably under the cap. The disconnect symptom (`-32000` reconnect loop) is fully eliminated in this configuration.

### Eval baseline (`pnpm run eval` on synthetic gold set)

- **find_chunks** recall@8 = 1.000, NDCG@8 = 0.844 (v2.5 baselines: recall@8 ≥ 0.850, NDCG@8 ≥ 0.700 — both clearly above)
- **find_neighbors graph correctness** = 1.000 (threshold 1.0)
- **find_neighbors semantic-rank** ordering = 0.800 (baseline floor 0.780), NDCG@8 = 0.831 (baseline floor 0.811)
- No regression vs v0.6.1 hybrid eval baselines.

## [0.6.1] - 2026-05-15

### Fixed

- **npm publish provenance mismatch** — `package.json:repository.url`, `homepage`, `bugs.url` updated from the pre-rename `burakarslan0110/codewikitap` to the current `burakarslan0110/codewikitap-mcp`. v0.6.0's CI publish rejected the sigstore attestation (E422) because the GitHub-emitted provenance recorded the renamed repo while `package.json` still pointed at the redirect URL. **v0.6.0 was never on npm; v0.6.1 is the first real release of the v0.6 feature set.** Same fix applied to `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, README badges, and the `/plugin marketplace add …` install commands in both READMEs.

## [0.6.0] - 2026-05-15

### BREAKING

- **Boot-time auto-prewarmer removed.** Indexing is now exclusively user-triggered via the `request_indexing` MCP tool. The watcher's `onDepsAdded → prewarmer.enqueueDeps` wiring is also gone. The `CODEWIKI_DISABLE_PREWARM`, `CODEWIKI_PREWARM_MAX_DEPS`, and `CODEWIKI_PREWARM_START_DELAY_MS` env vars no longer exist; setting them has no effect.

### Added

- **Recursive subdir scan.** `list_project_dependencies` now BFS-walks every subdirectory of cwd and emits all root manifests in `manifests[]`. Ignore set: `node_modules`, `.git`, `target`, `dist`, `build`, `.next`, `__pycache__`, `vendor`, `.venv`, `.nuxt`, `.gradle`, `out`, `coverage`. Bound by `CODEWIKI_SCAN_MAX_DEPTH` (default 8). Polyglot monorepos (frontend/+backend/+mobile/) work end-to-end without ceremony.
- **Framework context.** Every `manifests[i]` entry includes `frameworks: [{ name, confidence, sourceRepo, detectedFrom }]`. Curated signatures (~30) cover next.js, Nuxt, React, Angular, Svelte, NestJS, Express, Fastify, Spring Boot, Spring Framework, Django, Flask, FastAPI, Rails, Gin, Echo, Fiber, Chi, Actix, Axum, Rocket, Tokio (medium), ASP.NET Core, Blazor.
- **`ManifestWatcher.additionalRoots`** opt — single chokidar instance, path-to-root dispatch, root-first truncate priority at `MAX_WATCHED_PATHS=512`.

### Changed

- **`list_project_dependencies` output schema (additive, lock-list-safe).** New top-level `manifests[]` array + `manifestsTotal: number`. Top-level `projectRoot` / `manifestType` / `dependencies` / `total` remain as the "primary projection" of `manifests[0]` (cwd-nearest manifest) for back-compat. Pagination (`offset` / `limit`) applies ONLY to primary.

### Removed

- `src/services/prewarmer.ts`, `tests/unit/prewarmer.test.ts`, `tests/integration/prewarm_lifecycle.integration.test.ts`, `.claude/rules/codewikitap-prewarmer.md`.
- `PrewarmerError` / `PrewarmerErrorKind` types.
- `ManifestWatcherOpts.onDepsAdded` callback (YAGNI; no consumer remained after prewarmer removal).

## [0.5.3] - 2026-05-14

### Fixed

- BM25 returns 0 rows for multi-token queries

## [0.5.2] - 2026-05-14

### BREAKING

- **`list_pages` MCP tool removed.** Merged into `get_page` — agents migrating from 0.5.1 must call `get_page({ repo, listPages: true })` to fetch the page index. The output shape under that flag is identical to the legacy `list_pages` output.
- **Node.js floor raised: 20 → 22.5.** The runtime guard hard-exits on `< 22.5` with an `nvm/fnm/volta install 22` recovery message; `engines.node` is `>=22.5.0`.

### Changed

- **Tool surface narrowed 7 → 6.** Locked-name whitelist (`request_indexing`) and Cloudmeru-parity regex unchanged.
- **`sqlite-vec` moved `dependencies` → `optionalDependencies`.** Install no longer fails on platforms without a published prebuilt; pure-JS cosine fallback engages with a clear `sqlite_vec.unavailable` warn carrying actionable hint text.
- **`INDEX_BUILD_TIMEOUT_MS` default 5000 → 15000 ms.** `find_chunks` cold-path return now favours a populated response over `index_building`. The status envelope gains `estimatedRemainingSeconds` to help agents decide when to retry vs `request_indexing`.
- **Boot-time `runtime_capabilities` stderr line** announces `betterSqlite3`, `sqliteVec`, `playwright`, `nodeVersion`, `platform`, `arch` so cross-platform degradations surface before the first slow tool call.
- **NPX installer hardening:** atomic-write retries on Windows `EBUSY`/`ETXTBSY`, clearer `path_create_failed` error, postinstall Windows toolchain hint.

### Added

- `PlaywrightDriver.readyState: 'pending' | 'ready' | 'failed'` getter.
- Off-project query example in all 3 READMEs: `resolve_repo → request_indexing → find_chunks` composition.

## [0.5.1] - 2026-05-13

### Fixed

- pin Claude marketplace plugin version + add alt-install methods

### Notes

- Bump Claude plugin version to 0.5.0

## [0.5.0] - 2026-05-13

### Added

- cross-platform path resolution + Node version runtime guard

## [0.4.3] - 2026-05-13

### Fixed

- eliminate -32000 reconnect from stdout-wrap + slow playwright bootstrap

### Notes

- use new banner.png in main READMEs (was reverted to logo.png)
- bust GitHub camo cache (?v=2) so updated banner shows
- fix dotted-İ in disclaimer, add bottom-right credit
- Show install command in README and README.tr
- swap logo for centered Google-styled CodeWikiTap banner
- Add codewikitap banner image
- rename CodeWiKiTap -> CodeWikiTap to match banner
- replace logo with wide CodeWikiTap banner
- Remove code block for 'npx codewikitap'

## [0.4.2] - 2026-05-12

### Notes

- drop 'Why npx not npm install -g' subsection
- clarify npx vs npm install -g; add wizard to npm landing

## [0.4.1] - 2026-05-12

### Fixed

- resolve symlinks in bin-entry guard

## [0.4.0] - 2026-05-12

### Added

- add interactive `npx codewikitap install` wizard

## [0.3.1] - 2026-05-12

### Fixed

- **Auto-install Playwright chromium-headless-shell on package install.** The README always promised "first run downloads ~30 MB of Chromium", but Playwright v1.40+ no longer auto-downloads browsers in its own postinstall, so consumers of v0.3.0 hit `browserType.launch: Executable doesn't exist…` on the first `find_chunks` or `get_page` call. v0.3.1 adds a top-level `postinstall` hook (`scripts/postinstall.mjs`) that runs `playwright install --only-shell chromium` after `npm install` / `npx codewikitap`. Idempotent (skips when cached), fail-soft (prints a recovery command and exits 0 on download failure rather than breaking the install), and opt-out via `CODEWIKI_SKIP_POSTINSTALL=1` for CI image builders.

### Notes

- `verify-publish` smoke test sets `CODEWIKI_SKIP_POSTINSTALL=1` so the tarball-into-tmpdir install doesn't pull 30 MB on every release; tarball-shape assertions still verify `scripts/postinstall.mjs` is present in the published package.
- First-time installs now have an extra ~30 MB / ~20-second step inside `npm install`. Existing v0.3.0 installs that already ran `playwright install` manually are unaffected (the second download is a no-op).

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
