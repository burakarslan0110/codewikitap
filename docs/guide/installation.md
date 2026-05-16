# Installation

On first run, Playwright's `chromium-headless-shell` (~30 MB) is downloaded — CodeWiki is an Angular SPA and a plain HTTP request returns an empty shell, so a real browser is required. On the first `find_chunks` call, the ONNX embedder + reranker models (~50 MB combined) are downloaded. Both are one-time, persistently cached.

You don't run `codewikitap` directly — your agent launches it as a child process.

## Requirements

| | Minimum |
|---|---|
| **Node.js** | 22.5.0 |
| **OS** | macOS, Linux, Windows |
| **Disk** | ~150 MB (Playwright shell + ONNX models + index cache) |
| **Network** | First-run only (Playwright + models); subsequent queries are local until the 24h SHA probe runs |

## Interactive installer (recommended)

```bash
npx codewikitap install
```

The wizard prompts for target and scope, shows a diff if an existing entry would be overwritten, and writes the appropriate config file atomically with a `.bak` backup.

For scripted / CI use, all questions are flag-overridable:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
npx codewikitap install --target=cursor --scope=project --dry-run    # preview only
```

Available `--target` IDs: `claude-code`, `cursor`, `codex-cli`, `gemini-cli`, `qwen-code`, `opencode`, `windsurf`, `antigravity`. Available `--scope` values: `project`, `user` (some targets are user-only — the wizard auto-resolves).

## Alternative installation methods

| Agent | Method | Path |
|---|---|---|
| Claude Code | Plugin marketplace | `/plugin marketplace add burakarslan0110/codewikitap-mcp` → `/plugin install codewikitap@burakarslan0110-codewikitap` |
| Claude Code | Manual JSON | `~/.claude/mcp.json` or project `.mcp.json` |
| Cursor | Manual JSON | `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json` |
| Codex CLI | Manual TOML | `~/.codex/config.toml` |
| Gemini CLI | Manual JSON | `~/.gemini/settings.json` |
| Qwen Code | Manual JSON | `~/.qwen/settings.json` or project equivalent |
| opencode | Manual JSON | `opencode.json` or `~/.config/opencode/opencode.json` |
| Windsurf | Manual JSON | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity | Manual JSON | `~/.gemini/antigravity/mcp_config.json` |

The interactive wizard above is recommended — it handles diff, backup, and atomic-write for you. Manual blocks below for reference.

### Claude Code

`~/.claude/mcp.json` (user-level) or `.mcp.json` at the project root:

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

Or via the Claude plugin marketplace:

```text
/plugin marketplace add burakarslan0110/codewikitap-mcp
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

`~/.gemini/settings.json` under `mcpServers` — identical shape to Claude Code.

### Qwen Code

`~/.qwen/settings.json` or `<project>/.qwen/settings.json` — same JSON shape as Claude Code.

### opencode

`opencode.json` (project) or `~/.config/opencode/opencode.json` (user). opencode uses `mcp.<name>` (not `mcpServers`) and each entry needs a `type` discriminator:

```json
{
  "mcp": {
    "codewikitap": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "codewikitap"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` — same JSON shape as Claude Code. User scope only (no per-project config path documented upstream).

### Antigravity

`~/.gemini/antigravity/mcp_config.json` — same JSON shape as Claude Code. User scope only.

## Supported project types

CodeWikiTap reads your manifest to learn what your project actually depends on. **Nine ecosystems** are supported out of the box, with workspace traversal where applicable. Fifteen distinct manifest parsers cover them:

| Ecosystem | Manifest | Workspace / extras |
|---|---|---|
| **JavaScript / TypeScript** | `package.json` | npm/pnpm/yarn `workspaces`, `pnpm-workspace.yaml` |
| **Python** | `requirements.txt`, `pyproject.toml` | PEP 621 + Poetry |
| **Go** | `go.mod`, `go.work` | full workspace awareness |
| **Rust** | `Cargo.toml` | `[workspace] members` (literal + glob) |
| **PHP** | `composer.json` | platform packages auto-filtered |
| **Java (Maven)** | `pom.xml` | full property resolution + recursive cycle-safe BOM imports + `<parent>` POM + `<modules>` aggregator traversal |
| **Java (Gradle)** | `gradle/libs.versions.toml` | `settings.gradle(.kts)` subproject discovery + per-subproject `build.gradle(.kts)` parsing |
| **Ruby** | `Gemfile.lock` (preferred) | `Gemfile` regex fallback |
| **.NET** | `*.csproj` + `Directory.Packages.props` | CPM + `*.sln`-driven discovery |

Saying "react" in chat is enough — the resolver maps it to `facebook/react`. Maven Central, RubyGems, NuGet, crates.io, Packagist, and the npm registry are all integrated.

## Verifying it works

After installation, restart your agent and ask:

> Which of my dependencies have CodeWiki coverage?

The agent should call `list_project_dependencies` automatically and respond with a per-dependency coverage report. If you see "no MCP server registered," the config file was written but the agent didn't reload — restart the agent.

For troubleshooting (cold-start errors, `-32000`, missing prebuilts), see [Configuration → Troubleshooting](/guide/configuration#troubleshooting).

---

Next: [Architecture](/guide/architecture) — how it works under the hood.
