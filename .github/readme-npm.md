<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap-mcp/main/assets/codewikitap-demo-poster.jpg" alt="CodeWikiTap" width="720"/>
</p>

<p align="center">
  <strong>An <em>unofficial</em>, RAG-powered MCP server that streams Google CodeWiki documentation into your coding agent — chunked, cited, and grounded in the exact commit your dependency is pinned to.</strong>
</p>

<p align="center">
  <a href="https://github.com/burakarslan0110/codewikitap-mcp"><img src="https://img.shields.io/badge/source-GitHub-1D4ED8?logo=github&logoColor=white" alt="GitHub"/></a>
  <a href="https://burakarslan0110.github.io/codewikitap-mcp/"><img src="https://img.shields.io/badge/docs-GitHub_Pages-1D4ED8" alt="Documentation"/></a>
  <img src="https://img.shields.io/badge/license-MIT-1D4ED8.svg" alt="MIT"/>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white" alt="Node ≥22.5"/>
  <img src="https://img.shields.io/badge/status-unofficial-orange" alt="Unofficial"/>
</p>

<p align="center">
  📚 <strong><a href="https://burakarslan0110.github.io/codewikitap-mcp/">Full documentation</a></strong>
  · 🇹🇷 <a href="https://burakarslan0110.github.io/codewikitap-mcp/tr/">Türkçe</a>
</p>

## Install

```bash
npx codewikitap install
```

One command — interactive wizard that writes the MCP config block into your agent of choice. Pick a target (Claude Code, Cursor, Codex CLI, Gemini CLI, Qwen Code, opencode, Windsurf, Antigravity) and a scope (project or user). The wizard writes the correct config file atomically with a `.bak` backup. For CI / scripted use, every answer is a flag:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
npx codewikitap install --target=cursor --scope=project --dry-run    # preview only
```

No API keys, no cloud, no telemetry — it runs locally as an MCP server over stdio. First run downloads Playwright's `chromium-headless-shell` (~30 MB) and ONNX retrieval models (~50 MB), both one-time and persistently cached.

Full per-agent config blocks (manual, marketplace, paths) → [Installation guide](https://burakarslan0110.github.io/codewikitap-mcp/guide/installation).

## What it does

When you ask your coding agent *"why isn't my `revalidatePath` clearing the cache?"*, it typically guesses from training data. CodeWikiTap gives it the actual Next.js documentation — chunked, semantically retrieved, pinned to the exact commit your `next` dependency is on, with a citation footer it cannot strip.

It scans your project's manifest at startup, resolves direct dependencies to GitHub repos, and exposes **5 MCP tools** the agent can call:

- `list_project_dependencies` — pre-session coverage report across all manifests
- `resolve_repo` — name → `owner/repo` via npm / RubyGems / Maven Central / NuGet / crates.io / Packagist
- `get_page` — fetch a page, sub-section, table of contents (`listPages: true`), or pre-warm an index (`prepareOnly: true`)
- `find_chunks` — hybrid BM25 + vector + RRF + cross-encoder rerank; auto-indexes on first call; omit `repo` for off-project query
- `find_neighbors` — knowledge-graph traversal over the docs (5 stored edge kinds)

The data source is **[Google CodeWiki](https://codewiki.google)** — Gemini-generated documentation regenerated on every PR merge for every public GitHub repo. This package is **unofficial** and not affiliated with Google.

## What it supports

Direct dependencies in **9 ecosystems** are scanned automatically: JavaScript/TypeScript (`package.json` + workspaces), Python (`requirements.txt`, `pyproject.toml`), Go (`go.mod`, `go.work`), Rust (`Cargo.toml`), PHP (`composer.json`), Java Maven (`pom.xml` with `<parent>` + BOM resolution), Java Gradle (`libs.versions.toml` + per-subproject parsing), Ruby (`Gemfile.lock`), and .NET (`*.csproj` + `Directory.Packages.props` + `*.sln`).

Public GitHub repos only — CodeWiki upstream doesn't cover private repos yet.

## Useful env vars

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |
| `CODEWIKI_INCLUDE_DEV_DEPS` | off | Also scan `devDependencies`. |
| `CODEWIKI_DISABLE_WATCH` | off | Don't watch manifest changes (CI/CD). |
| `CODEWIKI_DISABLE_KG` | off | Skip knowledge graph; unregister `find_neighbors`. |
| `CODEWIKI_FORCE_NO_BM25` | off | Vector-only retrieval mode. |
| `CODEWIKI_RERANK_TOP_N` | `50` | Candidates passed to the reranker. |
| `CODEWIKI_NODE_HEAP_MB` | `1536` | V8 old-space heap cap (self-reexec wrapper). |

Full reference (35+ variables) → [Configuration guide](https://burakarslan0110.github.io/codewikitap-mcp/guide/configuration).

## More

- 📚 **[Documentation](https://burakarslan0110.github.io/codewikitap-mcp/)** — concepts, architecture, the 5 tools, configuration, troubleshooting
- 📦 **[Source on GitHub](https://github.com/burakarslan0110/codewikitap-mcp)** — issues, contributions, CHANGELOG
- 🇹🇷 **[Türkçe](https://burakarslan0110.github.io/codewikitap-mcp/tr/)** — Turkish documentation

## License

[MIT](https://github.com/burakarslan0110/codewikitap-mcp/blob/main/LICENSE) — © 2026 Burak Arslan.

> CodeWikiTap is an independent, **unofficial** project. It is not affiliated with, endorsed by, or sponsored by Google. The "CodeWiki" name is referenced descriptively as the upstream data source.
