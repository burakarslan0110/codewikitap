<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap/main/assets/logo.png" alt="CodeWiKiTap" width="460"/>
</p>

<p align="center">
  <strong>Unofficial, RAG-powered MCP server that streams Google CodeWiki docs into your coding agent.</strong>
</p>

<p align="center">
  <a href="https://github.com/burakarslan0110/codewikitap"><img src="https://img.shields.io/badge/docs-GitHub-1D4ED8" alt="Docs on GitHub"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1D4ED8.svg" alt="MIT"/></a>
  <img src="https://img.shields.io/badge/node-20.x-339933?logo=node.js&logoColor=white" alt="Node 20"/>
  <img src="https://img.shields.io/badge/status-unofficial-orange" alt="Unofficial"/>
</p>

## Install

```bash
npx codewikitap
```

That's the whole install. No API keys, no cloud, no telemetry — it runs locally as an MCP server over stdio. On first run, Playwright's `chromium-headless-shell` (~30 MB) and ONNX models for retrieval (~50 MB) are cached once.

## 30-second pitch

When you ask your coding agent *"why isn't my `revalidatePath` clearing the cache?"*, it typically guesses from training data. CodeWiKiTap gives it the actual Next.js documentation — chunked, semantically retrieved, pinned to the exact commit your `next` dependency is on, with a citation footer it cannot strip.

It scans your project's manifest at startup, resolves direct dependencies to GitHub repos, and exposes **seven MCP tools** the agent can call: `list_project_dependencies`, `resolve_repo`, `list_pages`, `get_page`, `find_chunks` (hybrid BM25 + vector + RRF + cross-encoder rerank), `find_neighbors` (knowledge-graph traversal over the docs), and `request_indexing` (pre-warm).

**The data source is [Google CodeWiki](https://codewiki.google)** — Gemini-generated documentation regenerated on every PR merge for every public GitHub repo. This package is **unofficial** and not affiliated with Google in any way.

## Wire it into your agent (pick one)

### Claude Code

`~/.claude/mcp.json` or project root `.mcp.json`:

```json
{
  "mcpServers": {
    "codewikitap": {
      "command": "npx",
      "args": ["-y", "codewikitap"]
    }
  }
}
```

Or via the marketplace:

```text
/plugin marketplace add burakarslan0110/codewikitap
/plugin install codewikitap@burakarslan0110-codewikitap
```

### Cursor

`~/.cursor/mcp.json` or `<project>/.cursor/mcp.json` — same JSON shape as Claude Code.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.codewikitap]
command = "npx"
args = ["-y", "codewikitap"]
```

### Gemini CLI

`~/.gemini/settings.json` under `mcpServers` — same shape as Claude Code.

### Qwen Code, opencode, Antigravity

Identical `mcpServers` JSON shape — paste, restart, done.

## What it supports

Direct dependencies in **11 ecosystems** are scanned automatically: JavaScript/TypeScript (`package.json` + workspaces), Python (`requirements.txt`, `pyproject.toml`), Go (`go.mod`, `go.work`), Rust (`Cargo.toml`), PHP (`composer.json`), Java Maven (`pom.xml` with `<parent>` + BOM resolution), Java Gradle (`libs.versions.toml` + per-subproject parsing), Ruby (`Gemfile.lock`), and .NET (`*.csproj` + `Directory.Packages.props` + `*.sln`).

Public GitHub repos only — CodeWiki upstream doesn't cover private repos yet.

## Useful env vars

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |
| `CODEWIKI_INCLUDE_DEV_DEPS` | off | Also scan `devDependencies`. |
| `CODEWIKI_DISABLE_WATCH` | off | Don't watch manifest changes (CI/CD). |
| `CODEWIKI_DISABLE_KG` | off | Skip knowledge graph; unregister `find_neighbors`. |
| `CODEWIKI_DISABLE_PREWARM` | off | Skip startup auto-prewarm. |
| `CODEWIKI_FORCE_NO_BM25` | off | Vector-only retrieval mode. |
| `CODEWIKI_RERANK_TOP_N` | `50` | Candidates passed to the reranker. |

## More

Full documentation, architecture diagrams, four real-world scenarios, and the why-RAG rationale live on GitHub:

→ **[github.com/burakarslan0110/codewikitap](https://github.com/burakarslan0110/codewikitap)** · [Türkçe README](https://github.com/burakarslan0110/codewikitap/blob/main/README.tr.md)

## License

[MIT](LICENSE) — © 2026 Burak Arslan.

> CodeWiKiTap is an independent, **unofficial** project. It is not affiliated with, endorsed by, or sponsored by Google. The "CodeWiki" name is referenced descriptively as the upstream data source.
