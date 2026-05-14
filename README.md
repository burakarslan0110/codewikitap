<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap-mcp/main/assets/banner.png?v=2" alt="CodeWikiTap" width="720"/>
</p>

<h1 align="center">CodeWikiTap</h1>

<p align="center">
  <strong>An <em>unofficial</em>, RAG-powered MCP server that streams Google CodeWiki documentation into your coding agent — chunked, cited, and grounded in the exact commit your dependency is pinned to.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codewikitap"><img src="https://img.shields.io/npm/v/codewikitap?color=1D4ED8&label=npm" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1D4ED8.svg" alt="MIT"/></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/node-20.x-339933?logo=node.js&logoColor=white" alt="Node"/></a>
  <a href="https://github.com/burakarslan0110/codewikitap-mcp/actions"><img src="https://github.com/burakarslan0110/codewikitap-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/status-unofficial-orange" alt="Unofficial"/>
</p>

<p align="center">
  🇬🇧 <strong>English</strong> · <a href="README.tr.md">🇹🇷 Türkçe</a>
</p>

```bash
npx codewikitap install
```

---

## Table of contents

1. [What is Google CodeWiki?](#what-is-google-codewiki)
2. [What is CodeWikiTap?](#what-is-codewikitap)
3. [Why RAG-powered (and not just dump the docs)?](#why-rag-powered)
4. [How it works under the hood](#how-it-works-under-the-hood)
5. [The seven tools](#the-seven-tools)
6. [Real-world scenarios](#real-world-scenarios)
7. [Installation per agent](#installation-per-agent)
8. [Supported project types](#supported-project-types)
9. [Configuration](#configuration)
10. [Things worth knowing](#things-worth-knowing)
11. [What this is *not*](#what-this-is-not)
12. [Roadmap, contributing, license](#roadmap)

---

<a id="what-is-google-codewiki"></a>
## What is Google CodeWiki?

[**Google CodeWiki**](https://codewiki.google) is a research project from Google that generates a deep, structured technical wiki for every public GitHub repository on the planet. It runs entirely on Gemini: every page is synthesized from the source tree, regenerated on each pull-request merge, and pinned to a specific commit SHA so the documentation never drifts away from the code.

What lands on a CodeWiki page is more than an API table:

- **Module-level explanations** that read like a senior engineer onboarding you — what the module does, how it fits, what it expects.
- **Architecture diagrams** (Mermaid) for the larger systems, regenerated from the actual call graph.
- **Cross-references** between source files, types, and other repositories.
- **Citation footer** on every page pointing at the exact commit + file the explanation was derived from.

Two practical caveats matter:

1. **Public GitHub only.** Private repos are gated behind a waitlisted Gemini extension; CodeWikiTap does not work around that.
2. **AI-generated content.** Gemini is good but not infallible. Every page links back to the source — verify when correctness matters.

> ⚠️ **CodeWikiTap is not affiliated with Google.** The CodeWiki name is referenced descriptively as the upstream data source. This is an independent open-source project; nothing here ships with, or is endorsed by, Google.

---

<a id="what-is-codewikitap"></a>
## What is CodeWikiTap?

CodeWikiTap is a small Node/TypeScript program that runs locally on your machine as a **Model Context Protocol (MCP) server**. Your coding agent (Claude Code, Cursor, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, …) talks to it over stdio, and it exposes a locked surface of **seven tools** — six read-only plus one pre-warm — that let the agent pull CodeWiki content into its context window on demand.

The shortest possible mental model:

```
       ┌────────────────────────┐
       │   Your coding agent    │
       │   asks a question      │
       └────────────┬───────────┘
                    │  stdio (JSON-RPC)
                    ▼
       ┌────────────────────────┐
       │      CodeWikiTap       │   ← local, no API keys, no telemetry
       │   (this MCP server)    │
       └────────────┬───────────┘
                    │  hybrid retrieval over indexed CodeWiki pages
                    ▼
       ┌────────────────────────┐
       │   Google CodeWiki      │   ← upstream, public repos only
       │   (cached, SHA-pinned) │
       └────────────────────────┘
```

What it actually adds on top of "just fetch CodeWiki":

- **Project awareness.** At startup it scans your manifest (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …) and resolves your *direct* dependencies to GitHub repos, then probes CodeWiki for coverage. The agent knows which libraries have docs **before** the first question.
- **Hybrid retrieval.** BM25 keyword search + dense vector search → Reciprocal Rank Fusion → cross-encoder rerank. Five separate scores are returned per chunk so the ranking is auditable, not a black box.
- **Knowledge graph.** While indexing, five typed edge kinds are extracted in the same SQLite transaction. The agent can ask "which docs reference `src/auth.ts`?" or "what is connected to the `AuthRouter` diagram node?".
- **Citation enforcement.** Every chunk and every page response carries a byte-equal footer with the source URL and pinned commit SHA. The footer is asserted in tests; there is no way to silence it.
- **Locked tool surface.** The server refuses to register an eighth tool. Names matching `/(search|ask|query|generate|index|write)/i` are rejected at code level — no plugin or hook can quietly extend the API.

---

<a id="why-rag-powered"></a>
## Why RAG-powered (and not just dump the docs)?

A typical CodeWiki page is dense — usually 2,000 to 4,000 tokens. A real library has many of them. Next.js, for example, is sitting on **18 pages** at the time of writing; React has dozens. Stuff them all into the agent's context and you blow the budget on documentation before you've even seen the question.

```
NAIVE (no RAG) — "give the agent everything"

   ┌─────────────────────────────────────────────────────────┐
   │ vercel/next.js CodeWiki = 18 pages × ~3,000 tok ≈ 54k   │
   │ facebook/react CodeWiki = 40+ pages × ~3,000 tok ≈ 120k │
   │ prisma/prisma CodeWiki  = 25+ pages × ~3,000 tok ≈ 75k  │
   │                              ...                         │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼  stuffed into the prompt
              ╳ context blown · ╳ cost spike · ╳ relevance drowns in noise


RAG (what CodeWikiTap does)

   54k tokens of Next.js docs
          │
          ▼  chunked at heading boundaries (canonical tree)
   ~200 chunks of ~250 tokens each
          │
          ▼  indexed once into cache.db
   BM25 (FTS5) ┐
               ├──► RRF fusion ──► cross-encoder rerank
   dense vec  ─┘                              │
                                              ▼
                          top-K chunks (~5 × ~250 tok ≈ 1.2k tok)
                                              │
                                              ▼
                          delivered to the agent with citations
              ✓ focused · ✓ cheap · ✓ auditable · ✓ verifiable
```

**Why hybrid (BM25 + vectors), not just one?**

- BM25 alone misses paraphrases — "data fetching" doesn't match "remote data loading".
- Vectors alone miss exact symbols — "`useEffect`" or "`revalidateTag`" need keyword precision.
- Fused via Reciprocal Rank Fusion (RRF, k=60), neither failure mode dominates. The cross-encoder rerank then re-orders the top candidates with full attention over query + chunk, fixing the residual ranking errors of both methods.

The result is a context payload that is roughly **40–80×** smaller than naive injection, with measurably higher recall (see `tests/eval/baseline-v2.7-hybrid.json` for the regression-locked floors: `NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80`).

---

<a id="how-it-works-under-the-hood"></a>
## How it works under the hood

Three things happen, mostly in the background:

### 1. Boot — figure out what this project depends on

```
   npx codewikitap launches
          │
          ▼
   Walk up from cwd → $HOME  (bounded, 32 levels max, never crosses $HOME)
          │
          ▼
   Match manifest by priority:
     pom.xml › *.sln › *.csproj › Cargo.toml › composer.json
       › go.work › go.mod › pyproject.toml › package.json › Gemfile.lock
          │
          ▼
   Parse direct deps  +  workspace members  +  BOMs  +  <parent> POMs
   (untrusted-input hardened: lstat, 1 MB cap, NUL-byte reject, no symlinks)
          │
          ▼
   Resolve each dep → owner/repo  (cache 7 days)
          │
          ▼
   Probe CodeWiki for coverage of each repo  (cache 24h, SHA-anchored)
          │
          ▼
   chokidar watcher subscribed to manifest + workspace members + aux files
   (so a fresh `pnpm add foo` is picked up without restarting the server)
```

### 2. Index — turn pages into searchable chunks (lazy)

The first time `find_chunks` or `find_neighbors` touches a repo, the indexer runs **once** per repo, atomically:

```
   Repo's CodeWiki page index
          │
          ▼
   getPage(repo, slug)  for each page  (Playwright → DOM → canonical tree)
          │
          ├──► chunker        — per-heading-section, not leaf-only
          ├──► graph_extractor — five edge kinds from the same tree
          └──► embedder       — bge-small-en-v1.5 ONNX, lazy-loaded
          │
          ▼
   ┌───────────────────── SQLite transaction ─────────────────────┐
   │  INSERT chunks        (text + page metadata)                  │
   │  INSERT vec_chunks    (sqlite-vec cosine virtual table)       │
   │  INSERT fts_chunks    (FTS5 virtual table, v2.7)              │
   │  INSERT kg_edges      (code_ref · diagram_edge · diagram_     │
   │                        member · section_link · cross_repo_ref)│
   │  UPDATE wiki_index_status                                     │
   └───────────────────────────────────────────────────────────────┘
          │
          ▼
   `request_indexing` lets the agent pre-warm a repo so the first real
   query never races the indexer's 5-second deadline.
```

### 3. Query — answer the question

```
   Agent calls find_chunks({ query: "...", repos: [...] })
          │
          ▼
   Race Indexer.indexRepo() vs 5 s deadline
          │
          ▼
   ┌────────────┐      ┌────────────┐
   │  BM25      │      │   Dense    │      ← parallel
   │  FTS5      │      │ sqlite-vec │
   └─────┬──────┘      └─────┬──────┘
         └─── RRF fusion (k=60) ───┘
                       │
                       ▼
            Top CODEWIKI_RERANK_TOP_N candidates  (default 50)
                       │
                       ▼
            Cross-encoder reranker  (ms-marco-MiniLM-L-6-v2)
                       │
                       ▼
            Top-K returned with:
              { text, title, slug, citationUrl, commitSha,
                vectorRank, vectorScore,
                bm25Rank,   bm25Score,
                rrfScore,   rerankScore }
```

If the index isn't ready inside the 5-second deadline, the call returns `status: 'index_building'` immediately and the build keeps running in the background — the next call hits a warm index.

---

<a id="the-seven-tools"></a>
## The seven tools

You don't call these directly — your agent does. The capability list is short on purpose; understanding what each one does helps you read the agent's reasoning.

### 1. `list_project_dependencies` — the foundation

Called once, automatically, at session start. The agent gets the full coverage report before its first thought.

```
   Session start
        │
        ▼
   Scan manifest  ──►  Resolve repos  ──►  Probe CodeWiki coverage
        │
        ▼
   [
     { name: "next",       repo: "vercel/next.js",     hasCodeWiki: true,  pages: 18 },
     { name: "react",      repo: "facebook/react",     hasCodeWiki: true,  pages: 42 },
     { name: "tailwindcss",repo: "tailwindlabs/...",   hasCodeWiki: true,  pages:  9 },
     { name: "@my-org/x",  repo: null,                 hasCodeWiki: false, pages:  0 },
     ...
   ]
```

### 2. `resolve_repo` — name → `owner/repo`

Skipped when the agent already knows the slug. Used when a user says "look up docs for react" and the resolver has to map `react` → `facebook/react`.

```
   "react"  ─►  npm registry  ─►  repository.url  ─►  facebook/react
   "lodash" ─►  npm           ─►  github.com/...  ─►  lodash/lodash
   "rails"  ─►  RubyGems      ─►  source_code_uri ─►  rails/rails
```

### 3. `get_page` — fetch one page, sub-section, or the page index

```
   Input:  { owner, repo, slug?, subsection?, listPages? }
        │
        ├─ listPages: true ─► returns the table of contents:
        │                       [{ slug, title, level, parentSlug, hasDiagrams }, ...]
        │
        ▼
   cache.db hit?
        ├─ fresh (≤ 24h)     ─►  return immediately
        ├─ expired           ─►  SHA probe: same commit?
        │                          ├─ yes ─► refresh TTL, return cached
        │                          └─ no  ─► re-fetch full page
        └─ miss              ─►  Playwright → canonical tree → Markdown
        │
        ▼
   Markdown + diagrams + code + the citation footer (byte-equal, asserted)
```

### 4. `find_chunks` — the workhorse (hybrid RAG, project- or off-project)

See the diagram above. The thing to know is that **five scores** come back with each chunk: `vectorScore`, `bm25Score`, `rrfScore`, `rerankScore`, plus the two pre-fusion ranks. If the agent (or you) ever wonder *why* a chunk was returned, the answer is fully inspectable.

**Off-project query.** Omit `repo` to search across all repos already indexed in the local cache. To ask CodeWiki about a brand-new repo that isn't in your dependencies, compose three tools:

```
   resolve_repo({ query: "react" })                              → { owner: "facebook", repo: "react" }
   request_indexing({ repo: "facebook/react" })                  → { status: "ready" | "index_building" }
   find_chunks({ query: "rules of hooks", repo: "facebook/react" })
                                                                 → ranked chunks with citations
```

### 5. `find_neighbors` — knowledge-graph traversal

Five stored edge kinds plus a query-time-derived `dep_link`:

```
   code_ref         page  ──refers──►  source file
   diagram_edge     node  ──edge────►  node            (inside a diagram)
   diagram_member   node  ──in──────►  diagram cluster
   section_link    section ──anchor►  section          (same page)
   cross_repo_ref   page  ──cites───►  external repo
   ──────────────────────────────────────────────────────────────────────
   dep_link        project ──uses──►  indexed repo     (derived at query time)
```

With the optional `query` parameter, neighbors are re-ranked by semantic similarity — the embedder is reused, no separate model.

### 6. `request_indexing` — pre-warm (the only non-readonly tool)

A polite "please build the index for this repo now so my next call doesn't pay the cold start." Useful when the agent has decided it will explore a library before the user actually asks anything about it.

```
   request_indexing({ owner, repo })
        │
        ▼
   Kick off Indexer.indexRepo() in background, return immediately
        │
        ▼
   Next find_chunks for that repo → warm index, no race, instant
```

---

<a id="real-world-scenarios"></a>
## Real-world scenarios

### Scenario 1 — The Next.js cache mystery

> *"Why isn't my `revalidatePath` call refreshing the cached fetch in this component?"*

```
   Agent's reasoning (visible in tool traces):
   ─────────────────────────────────────────────────────────────
   1. (from session start) list_project_dependencies told me
      next → vercel/next.js, 18 pages indexed.

   2. find_chunks({
        query: "revalidatePath cached fetch server component",
        repos: ["vercel/next.js"]
      })
      ► top chunk: "On-demand revalidation" section, rrfScore 0.84,
        rerankScore 9.2.

   3. get_page({
        owner: "vercel", repo: "next.js",
        slug: "app-router/caching",
        subsection: "on-demand-revalidation"
      })
      ► full Markdown with revalidatePath(path, type) signature.

   4. find_neighbors({ source: "node", id: "RouteCache" })
      ► RouteCache ─► FullRouteCache, DataCache, RouterCache,
                       RequestMemoization (all with citations).
   ─────────────────────────────────────────────────────────────
   Answer (paraphrased):
     "revalidatePath(path) without a type argument invalidates only the
     route segment cache. Your force-cache fetch lives in the Data Cache,
     keyed independently. Use revalidatePath(path, 'page') or tag the
     fetch and call revalidateTag(tag).  — source pinned to commit a1b2c3d"
```

### Scenario 2 — Onboarding to an unfamiliar library

> *"I just added `tanstack-query` to the project. Give me a tour."*

```
   Agent's tools:
     resolve_repo("@tanstack/react-query")             → TanStack/query
     request_indexing({ owner, repo })                 → pre-warm
     get_page({ owner, repo, listPages: true })        → 14 pages
     find_chunks({ query: "core concepts",             → 5 chunks
                   repo: "TanStack/query", k: 5 })
     get_page({ owner, repo, slug: "guides/important-defaults" })

   What the user sees:
     A grounded, citation-laden overview — "queries", "mutations",
     "staleTime vs gcTime", "queryClient invalidation" — pinned to
     the exact commit they just installed.
```

### Scenario 3 — Architecture exploration via knowledge graph

> *"Show me the data flow in the Prisma client."*

```
   find_neighbors({ source: "page",
                    slug: "client/architecture",
                    kinds: ["diagram_edge", "diagram_member"] })
        │
        ▼
   QueryEngine ─► Request ─► Connector ─► Driver ─► Database
        │          │           │           │
        └──────────┴───────────┴───────────┴──► all carry citations
                                                 to specific source
                                                 files (code_ref edges)
```

The agent assembles an architecture summary that names actual modules in the actual codebase, not generic ORM hand-waving.

### Scenario 4 — Pre-warm before a deep dive

> *"I'm going to refactor our auth flow this afternoon. Make sure docs for `next-auth`, `lucia`, and `iron-session` are ready."*

```
   for repo in [nextauthjs/next-auth, lucia-auth/lucia, vvo/iron-session]:
       request_indexing({ owner, repo })
   ─────────────────────────────────────────────────────────────
   ~12 seconds later, three indexes are warm in cache.db. Every
   subsequent find_chunks call returns in <50 ms, no cold starts.
```

---

<a id="installation-per-agent"></a>
## Installation per agent

On first run, Playwright's `chromium-headless-shell` (~30 MB) is downloaded — CodeWiki is an Angular SPA and a plain HTTP request returns an empty shell, so a real browser is required. On the first `find_chunks` call, the ONNX embedder + reranker models (~50 MB combined) are downloaded. Both are one-time, persistently cached.

You don't run `codewikitap` directly — your agent launches it as a child process. Either run the interactive installer below (recommended), or paste the manual config block for your agent of choice.

### Interactive installer (recommended)

```bash
npx codewikitap install
```

Prompts for target (Claude Code, Cursor, Codex CLI, Gemini CLI, Qwen Code, opencode, Windsurf, Antigravity) and scope (project or user), shows a diff if an existing entry would be overwritten, and writes the appropriate config file atomically with a `.bak` backup.

For scripted / CI use, all questions are flag-overridable:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
npx codewikitap install --target=cursor --scope=project --dry-run    # preview only
```

Available `--target` IDs: `claude-code`, `cursor`, `codex-cli`, `gemini-cli`, `qwen-code`, `opencode`, `windsurf`, `antigravity`. Available `--scope` values: `project`, `user` (some targets are user-only — the wizard auto-resolves).

### Alternative installation methods

Beyond `npx codewikitap install`, you can wire codewikitap in by hand or via a CLI-native plugin command where one exists. Full per-CLI config blocks live below.

| CLI | Method | Command / Path |
|---|---|---|
| Claude Code | Plugin marketplace | `/plugin marketplace add burakarslan0110/codewikitap-mcp` → `/plugin install codewikitap@burakarslan0110-codewikitap` |
| Claude Code | Manual JSON | `~/.claude/mcp.json` or project `.mcp.json` ([block](#claude-code)) |
| Cursor | Manual JSON | `~/.cursor/mcp.json` or `<project>/.cursor/mcp.json` ([block](#cursor)) |
| Codex CLI | Manual TOML | `~/.codex/config.toml` — no first-party marketplace yet ([block](#codex-cli)) |
| Gemini CLI | Manual JSON | `~/.gemini/settings.json` — no first-party marketplace yet ([block](#gemini-cli)) |
| Qwen Code | Manual JSON | `~/.qwen/settings.json` or project equivalent ([block](#qwen-code)) |
| opencode | Manual JSON | `opencode.json` or `~/.config/opencode/opencode.json` ([block](#opencode)) |
| Windsurf | Manual JSON | `~/.codeium/windsurf/mcp_config.json` ([block](#windsurf)) |
| Antigravity | Manual JSON | `~/.gemini/antigravity/mcp_config.json` ([block](#antigravity)) |

All paths point to the canonical config locations documented below. The interactive wizard above is recommended — it handles diff/backup/atomic-write for you.

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

---

<a id="supported-project-types"></a>
## Supported project types

CodeWikiTap reads your manifest to learn what your project actually depends on. Eleven ecosystems are supported out of the box, with workspace traversal where applicable:

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

---

<a id="configuration"></a>
## Configuration

Defaults are sufficient for most cases. The variables you might actually reach for:

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | Stderr log verbosity (`debug` / `info` / `warn` / `error`). |
| `CODEWIKI_INCLUDE_DEV_DEPS` | off | Also scan `devDependencies` (useful when test-tool docs matter). |
| `CODEWIKI_DISABLE_WATCH` | off | Don't watch manifest changes (CI/CD). |
| `CODEWIKI_DISABLE_KG` | off | Skip knowledge graph; `find_neighbors` is unregistered. |
| `CODEWIKI_DISABLE_MODEL_WARMUP` | off | Skip boot-time embedder + reranker warmup (cold-load shifts to first `find_chunks`). |
| `CODEWIKI_STDOUT_TRIPWIRE` | off | Diagnostic side-observe wrapper around stdout; warns on non-JSON-RPC bytes. Never reroutes. |
| `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS` | `180000` | Wallclock cap on the boot-time `npx playwright install`. |
| `CODEWIKI_SCAN_MAX_DEPTH` | `8` | Max BFS depth for the recursive subdir scan in `list_project_dependencies`. |
| `CODEWIKI_FORCE_NO_BM25` | off | Vector-only mode (BM25 branch skipped). |
| `CODEWIKI_RERANK_TOP_N` | `50` | Candidate count passed to the reranker. |

Full reference is in [CONTRIBUTING.md](CONTRIBUTING.md).

### Native dependencies (sqlite-vec, better-sqlite3)

Both `sqlite-vec` and `better-sqlite3` are declared as **optional native dependencies**. Install never fails on a platform without a published prebuilt:

| Native dep | When unavailable | Effect |
|---|---|---|
| `better-sqlite3` | macOS/Windows without prebuilt + no toolchain | In-memory cache fallback; no on-disk `cache.db` (queries still work, restart loses cache) |
| `sqlite-vec` | macOS SIP, sandbox, Windows ARM, Alpine musl | Pure-JS cosine fallback in `vector_store.ts`; ~5–10× slower vector queries on large repos. Native cosine ranking still mathematically equivalent. |

On boot the server emits one structured stderr line:

```json
{"level":"info","msg":"runtime_capabilities","betterSqlite3":true,"sqliteVec":false,"playwright":"ready","nodeVersion":"22.5.0",...}
```

If you see `sqliteVec: false` and queries feel slow, install the matching `sqlite-vec` prebuilt or rebuild from source:

```
npm rebuild sqlite-vec
```

### Troubleshooting: MCP `-32000` on cold start

When the very first run of `npx codewikitap` shows the MCP client reporting `-32000` and reconnecting:

1. The cause is usually a stalled or denied `npx playwright install --only-shell chromium` inside the codewikitap process (corporate proxy, offline sandbox, npm registry unreachable). Run the install manually once:

   ```
   npx playwright install --only-shell chromium
   ```

2. Then restart codewikitap. Subsequent runs use the on-disk binary and reach `transport.connect()` within milliseconds.

3. If the install fails and you need the server to come up immediately with browser-using tools degraded, set `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS=5000`. The MCP handshake succeeds and browser tools (`get_page`, `find_chunks` cache-miss, `find_neighbors` cache-miss, `request_indexing`) return a structured `rate_limited` retry envelope until the install completes. Non-browser tools (`list_project_dependencies`, `resolve_repo`) work unaffected.

---

<a id="things-worth-knowing"></a>
## Things worth knowing

- **AI-generated content.** Google CodeWiki pages are produced by Gemini and may contain errors. The byte-equal citation footer on every chunk and page is meant to be used for verification.
- **Rate limit.** CodeWiki is an Angular SPA with active bot detection. CodeWikiTap self-throttles to **one page load per four seconds per origin**. Typical interactive use never feels this; bulk-indexing many repos at once will.
- **Install footprint.** First run: ~30 MB Playwright shell. First `find_chunks`: ~50 MB ONNX models. Both one-time, persistently cached under `~/.cache/...`.
- **Scope.** Direct dependencies only. `peerDependencies` and transitive deps are out of scope; npm `optionalDependencies` are in.
- **Offline-friendly.** Once a repo's chunks + KG edges are in `cache.db`, queries work without a network round-trip until the 24h SHA probe kicks in.

---

<a id="what-this-is-not"></a>
## What this is *not*

- **Not an AI model.** No model is bundled here. CodeWikiTap improves the *context quality* delivered to the AI your agent already uses.
- **Not a documentation generator.** Content is not produced here. It is fetched from Google CodeWiki, which Gemini produces.
- **Not a cloud service.** Nothing leaves your machine. Local SQLite cache, local ONNX inference, zero telemetry.
- **Not affiliated with Google.** Independent open-source project; the upstream "CodeWiki" name is referenced descriptively as the data source.
- **Not for private repos.** Google CodeWiki currently covers only public GitHub repos; private-repo access is a waitlisted Gemini CLI extension.

---

<a id="roadmap"></a>
## Roadmap

- **v0.3** *(current)* — First public npm release. Bilingual docs, plugin marketplace, CI/CD, brand identity.
- **v0.4** — `--version` / `--help` argv handlers; expanded smoke-test coverage; macOS CI matrix.
- **v0.5+** — Hosted remote MCP transport (Cloudflare Workers + Browser Rendering) for zero-local-install deployments.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pnpm toolchain, test workflow, and release process. Security vulnerabilities: see [SECURITY.md](SECURITY.md) — please don't file them as public issues.

---

## License

[MIT](LICENSE) — © 2026 Burak Arslan.

> CodeWikiTap is an independent, **unofficial** project. It is not affiliated with, endorsed by, or sponsored by Google. The "CodeWiki" name is referenced descriptively as the upstream data source.
