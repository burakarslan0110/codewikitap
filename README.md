<h1 align="center">CodeWikiTap</h1>



https://github.com/user-attachments/assets/b57e8cfb-a6f3-4d59-a41a-92c8b4a8fcc6



<p align="center">
  <strong>An <em>unofficial</em>, RAG-powered MCP server that streams Google CodeWiki documentation into your coding agent — chunked, cited, and grounded in the exact commit your dependency is pinned to.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codewikitap"><img src="https://img.shields.io/npm/v/codewikitap?color=1D4ED8&label=npm" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1D4ED8.svg" alt="MIT"/></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white" alt="Node ≥22.5"/>
  <a href="https://github.com/burakarslan0110/codewikitap-mcp/actions"><img src="https://github.com/burakarslan0110/codewikitap-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/status-unofficial-orange" alt="Unofficial"/>
</p>

<p align="center">
  🇬🇧 <strong>English</strong> · <a href="README.tr.md">🇹🇷 Türkçe</a>
</p>

<p align="center">
  📚 <strong><a href="https://burakarslan0110.github.io/codewikitap-mcp/">Full documentation</a></strong> — concepts, architecture, the 5 tools, configuration reference, troubleshooting.
</p>

```bash
npx codewikitap install
```

---

## What it is

A small Node program that runs locally as an [**MCP server**](https://modelcontextprotocol.io). Your coding agent (Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, Windsurf) talks to it over stdio and the server exposes **5 tools** that let the agent pull [Google CodeWiki](https://codewiki.google) documentation into context on demand — chunked at heading boundaries, scored with hybrid BM25 + vector + cross-encoder rerank, and stamped with a byte-equal citation footer.

```
   ┌─────────────────┐   stdio    ┌─────────────────┐  hybrid retrieval  ┌─────────────────┐
   │  Coding agent   │ ─────────► │   CodeWikiTap   │ ─────────────────► │ Google CodeWiki │
   │  asks a question│            │  (local server) │ cached, SHA-pinned │  (public only)  │
   └─────────────────┘            └────────┬────────┘                    └─────────────────┘
                                           │
                                           │ traversal
                                           │
                                  ┌────────┴────────┐
                                  │ Knowledge graph │
                                  │  5 edge types   │
                                  └─────────────────┘

                          no API keys  ·  no telemetry  ·  local cache
```

**Why RAG and not "just fetch the docs"?** A typical CodeWiki page is 2–4 k tokens; Next.js alone has 18 pages. Naive injection blows the context budget before the question is even read. CodeWikiTap returns ~5 chunks of ~250 tokens each — roughly **40–80× smaller** with higher recall (regression-locked: `NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80`).

## Quick install

```bash
npx codewikitap install
```

The interactive wizard prompts for target and scope, shows a diff, and writes the config atomically with a `.bak` backup. For scripted use:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
```

| Agent | Config path |
|---|---|
| Claude Code | `~/.claude/mcp.json` or project `.mcp.json` (or [plugin marketplace](https://burakarslan0110.github.io/codewikitap-mcp/guide/installation#claude-code)) |
| Cursor | `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json` |
| VS Code | `<project>/.vscode/mcp.json` or platform-aware user dir (Linux `~/.config/Code/User/mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`) |
| Codex CLI | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| Qwen Code | `~/.qwen/settings.json` |
| opencode | `opencode.json` or `~/.config/opencode/opencode.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |

Full per-agent config blocks live in the [Installation guide](https://burakarslan0110.github.io/codewikitap-mcp/guide/installation).

**Requirements:** Node ≥ 22.5, ~150 MB disk (Playwright shell + ONNX models + cache). First run downloads `chromium-headless-shell` (~30 MB) and embedder/reranker models (~50 MB) — both one-time, persistently cached.

## Example — the Next.js cache mystery

> *"Why isn't my `revalidatePath` call refreshing the cached fetch?"*

```
   Agent's tool trace
   ──────────────────────────────────────────────────────────
   1. list_project_dependencies  → next → vercel/next.js, 18 pages indexed
   2. find_chunks({ query: "revalidatePath cached fetch", repos: ["vercel/next.js"] })
                                 → top chunk: "On-demand revalidation",
                                   rrfScore 0.84, rerankScore 9.2
   3. get_page({ slug: "app-router/caching", subsection: "on-demand-revalidation" })
                                 → full Markdown with revalidatePath(path, type) signature
   4. find_neighbors({ source: "node", id: "RouteCache" })
                                 → FullRouteCache, DataCache, RouterCache, RequestMemoization
   ──────────────────────────────────────────────────────────
   Answer:
     "revalidatePath(path) without a type only invalidates the route segment cache.
      Your force-cache fetch lives in the Data Cache — use revalidatePath(path, 'page')
      or tag the fetch and call revalidateTag(tag).   — pinned to commit a1b2c3d"
```

More examples in the [Tools guide](https://burakarslan0110.github.io/codewikitap-mcp/guide/tools#real-world-scenarios).

## Supported projects

**Nine ecosystems**, fifteen manifest parsers: JavaScript / TypeScript, Python, Go, Rust, PHP, Java (Maven), Java (Gradle), Ruby, .NET. Workspace traversal, BOM imports, parent POM resolution where applicable. Full matrix → [Installation guide](https://burakarslan0110.github.io/codewikitap-mcp/guide/installation#supported-project-types).

## What it's not

- **Not an AI model.** No model is bundled. CodeWikiTap improves the *context quality* delivered to the AI your agent already uses.
- **Not a cloud service.** Nothing leaves your machine. Local SQLite, local ONNX inference, zero telemetry.
- **Not affiliated with Google.** Independent open-source project; "CodeWiki" is referenced descriptively as the data source.
- **Not for private repos.** Google CodeWiki currently covers only public GitHub repos.

## More

- 📚 **[Documentation](https://burakarslan0110.github.io/codewikitap-mcp/)** — concepts, architecture, the 5 tools, configuration reference
- 📜 **[CHANGELOG](CHANGELOG.md)** — what changed and when
- 🤝 **[Contributing](CONTRIBUTING.md)** — pnpm toolchain, test workflow, release process
- 🔐 **[Security](SECURITY.md)** — please don't file vulnerabilities as public issues

## License

[MIT](LICENSE) — © 2026 Burak Arslan.

> CodeWikiTap is an independent, **unofficial** project. It is not affiliated with, endorsed by, or sponsored by Google. The "CodeWiki" name is referenced descriptively as the upstream data source.
