# The 5 tools

You don't call these directly — your agent does. The capability list is short on purpose; understanding what each one does helps you read the agent's reasoning.

::: tip Locked surface
The server registers exactly **five tools**. A regex in `buildServer()` rejects any name containing `search`, `ask`, `query`, `generate`, `index`, or `write` — no plugin or hook can quietly extend the API. `get_page` is the only non-readonly tool (the `prepareOnly: true` branch performs an HTTP fetch + sqlite write).
:::

## 1. `list_project_dependencies` — the foundation

Called once, automatically, at session start. The agent gets the full coverage report before its first thought.

```
   Session start
        │
        ▼
   Scan manifest  ──►  Resolve repos  ──►  Probe CodeWiki coverage
        │
        ▼
   [
     { name: "next",        repo: "vercel/next.js",     hasCodeWiki: true,  pages: 18 },
     { name: "react",       repo: "facebook/react",     hasCodeWiki: true,  pages: 42 },
     { name: "tailwindcss", repo: "tailwindlabs/...",   hasCodeWiki: true,  pages:  9 },
     { name: "@my-org/x",   repo: null,                 hasCodeWiki: false, pages:  0 },
     ...
   ]
```

## 2. `resolve_repo` — name → `owner/repo`

Skipped when the agent already knows the slug. Used when a user says "look up docs for react" and the resolver has to map `react` → `facebook/react`.

```
   "react"  ─►  npm registry  ─►  repository.url  ─►  facebook/react
   "lodash" ─►  npm           ─►  github.com/...  ─►  lodash/lodash
   "rails"  ─►  RubyGems      ─►  source_code_uri ─►  rails/rails
```

Returns `status: "no_match"` when the registry has no GitHub repository URL.

## 3. `get_page` — fetch a page, sub-section, table of contents, or pre-warm

Three modes from one tool:

```
   Input:  { owner, repo, slug?, subsection?, listPages?, prepareOnly? }
        │
        ├─ listPages: true ──► returns the table of contents:
        │                        [{ slug, title, level, parentSlug, hasDiagrams }, ...]
        │
        ├─ prepareOnly: true ─► kicks off the indexer in the background,
        │                       returns { status: "ready" | "index_building" }
        │
        ▼  (default — fetch a page)
   cache.db hit?
        ├─ fresh (≤ 24 h)    ─►  return immediately
        ├─ expired           ─►  SHA probe: same commit?
        │                          ├─ yes ─► refresh TTL, return cached
        │                          └─ no  ─► re-fetch full page
        └─ miss              ─►  Playwright → canonical tree → Markdown
        │
        ▼
   Markdown + diagrams + code + the citation footer (byte-equal, asserted)
```

`get_page` is the **only non-readonly tool**. The `prepareOnly: true` branch performs an HTTP fetch + sqlite write subject to the CodeWiki 1-page-per-4-seconds-per-origin rate limit. The `request_indexing` tool from v0.6 was folded into this branch in v0.7.

## 4. `find_chunks` — the workhorse (hybrid RAG)

The hybrid retrieval pipeline. Five scores come back with each chunk: `vectorScore`, `bm25Score`, `rrfScore`, `rerankScore`, plus the two pre-fusion ranks. If the agent (or you) ever wonder *why* a chunk was returned, the answer is fully inspectable.

**Off-project query.** Omit `repo` to search across all repos already indexed in the local cache. To ask CodeWiki about a brand-new repo that isn't in your dependencies, compose three tools:

```
   resolve_repo({ query: "react" })                              → { owner: "facebook", repo: "react" }
   get_page({ repo: "facebook/react", prepareOnly: true })       → { status: "ready" | "index_building" }
   find_chunks({ query: "rules of hooks", repo: "facebook/react" })
                                                                 → ranked chunks with citations
```

When the reranker is unavailable (download timeout, runtime error, circuit-breaker open), the result still comes back — ordered by vector similarity only and tagged `degraded: true`.

## 5. `find_neighbors` — knowledge-graph traversal

Five stored edge kinds plus a query-time-derived `dep_link`:

```
   code_ref         page    ──refers──►  source file
   diagram_edge     node    ──edge────►  node             (inside a diagram)
   diagram_member   node    ──in──────►  diagram cluster
   section_link     section ──anchor──►  section          (same page)
   cross_repo_ref   page    ──cites───►  external repo
   ──────────────────────────────────────────────────────────────────────
   dep_link         project ──uses────►  indexed repo     (derived at query time)
```

With the optional `query` parameter, neighbors are re-ranked by semantic similarity — the embedder is reused, no separate model. `find_neighbors` is unregistered entirely when `CODEWIKI_DISABLE_KG=1` (the rollback path).

## Status envelopes

Several tools can fail-soft instead of throwing. The structured `status` field on the result tells the agent what to do:

| Status | Meaning |
|---|---|
| `ok` | Default success (often omitted). |
| `no_docs` | Repo has no CodeWiki coverage. The result includes a `fallbacks` array with alternative URLs (GitHub, npm). |
| `no_match` | `resolve_repo` couldn't find a GitHub URL in the registry metadata. |
| `rate_limited` | Upstream backoff. Result includes `retryAfterSeconds`. |
| `retry` | Transient failure. Result includes `retryAfterSeconds`. |
| `index_building` | Indexer raced past `INDEX_BUILD_TIMEOUT_MS`. Empty result; client should retry shortly. |
| `degraded` | Reranker fell back; results still returned (boolean field on the result, not a status enum). |

Hard errors (validation, programmer error, infrastructure failure) are thrown — the MCP SDK translates throws into `isError: true`.

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
      ► top chunk: "On-demand revalidation" section,
        rrfScore 0.84, rerankScore 9.2.

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
     get_page({ owner, repo, prepareOnly: true })      → pre-warm
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

The agent assembles an architecture summary that names actual modules in the actual codebase — not generic ORM hand-waving.

### Scenario 4 — Pre-warm before a deep dive

> *"I'm going to refactor our auth flow this afternoon. Make sure docs for `next-auth`, `lucia`, and `iron-session` are ready."*

```
   for repo in [nextauthjs/next-auth, lucia-auth/lucia, vvo/iron-session]:
       get_page({ owner, repo, prepareOnly: true })
   ─────────────────────────────────────────────────────────────
   ~12 seconds later, three indexes are warm in cache.db. Every
   subsequent find_chunks call returns in <50 ms, no cold starts.
```

---

Next: [Configuration](/guide/configuration) — environment variables, troubleshooting, and operator knobs.
