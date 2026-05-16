# Architecture

Three things happen, mostly in the background.

## 1. Boot — figure out what this project depends on

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
   Probe CodeWiki for coverage of each repo  (cache 24 h, SHA-anchored)
          │
          ▼
   chokidar watcher subscribed to manifest + workspace members + aux files
   (so a fresh `pnpm add foo` is picked up without restarting the server)
```

## 2. Index — turn pages into searchable chunks (lazy)

The first time `find_chunks` or `find_neighbors` touches a repo, the indexer runs **once** per repo, atomically:

```
   Repo's CodeWiki page index
          │
          ▼
   getPage(repo, slug)  for each page  (Playwright → DOM → canonical tree)
          │
          ├──► chunker         — per-heading-section, not leaf-only
          ├──► graph_extractor — five edge kinds from the same tree
          └──► embedder        — bge-small-en-v1.5 ONNX, lazy-loaded
          │
          ▼
   ┌───────────────────── SQLite transaction ─────────────────────┐
   │  INSERT chunks        (text + page metadata)                  │
   │  INSERT vec_chunks    (sqlite-vec cosine virtual table)       │
   │  INSERT fts_chunks    (FTS5 virtual table)                    │
   │  INSERT kg_edges      (code_ref · diagram_edge · diagram_     │
   │                        member · section_link · cross_repo_ref)│
   │  UPDATE wiki_index_status                                     │
   └───────────────────────────────────────────────────────────────┘
          │
          ▼
   `get_page({ repo, prepareOnly: true })` lets the agent pre-warm a repo so
   the first real query never races the indexer's build deadline.
```

The indexer is **single-flight per repo** — concurrent callers collapse into one in-flight promise. Freshness is governed by `wiki_index_status.indexed_at` against `CODEWIKI_INDEX_TTL_MS` (default 24 h). If the TTL is expired but the upstream `commit_sha` matches, only the timestamp is refreshed; if the SHA changed, the full rebuild runs.

## 3. Query — answer the question

```
   Agent calls find_chunks({ query: "...", repos: [...] })
          │
          ▼
   Race Indexer.indexRepo() vs INDEX_BUILD_TIMEOUT_MS  (default 15 s)
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

If the index isn't ready inside the deadline, the call returns `status: 'index_building'` immediately and the build keeps running in the background — the next call hits a warm index. If the reranker fails (download timeout or runtime error), the result falls back to vector-only ordering and the response is tagged `degraded: true` — the chunks still come back, just with a less precise ordering.

## Native dependencies and runtime fallbacks

Two native dependencies are declared as **optional** in `package.json`:

| Native dep | When unavailable | Effect |
|---|---|---|
| `better-sqlite3` | macOS/Windows without a prebuilt + no toolchain | In-memory cache fallback; no on-disk `cache.db`. Queries still work, restart loses cache. |
| `sqlite-vec` | macOS SIP, sandbox, Windows ARM, Alpine musl | Pure-JS cosine fallback in `vector_store.ts`. ~5–10× slower vector queries on large repos; ranking is mathematically equivalent. |

On boot the server emits one structured stderr line:

```json
{"level":"info","msg":"runtime_capabilities","betterSqlite3":true,"sqliteVec":false,"playwright":"ready","nodeVersion":"22.5.0",...}
```

You can force the pure-JS cosine path even when `sqlite-vec` is available via `CODEWIKI_FORCE_PUREJS_VECTOR=1` — useful when you suspect the native extension is misbehaving.

## Resource governance

The bin entry self-execs once at startup with `--max-old-space-size=1536` when the flag is absent in `process.execArgv`. On 7.5 GB / 2 GB-swap hosts this stops the Linux OOM-killer from `SIGKILL`-ing the server child under repeated `find_chunks` load. The wrapper inherits stdio so the MCP JSON-RPC transport is unaffected; the wrapper PID exits immediately when the child exits.

Operator escape hatches:

| Env var | Default | Effect |
|---------|---------|--------|
| `CODEWIKI_NODE_HEAP_MB` | `1536` | Override the heap cap (in megabytes). |
| `CODEWIKI_DISABLE_HEAP_CAP` | unset | Set to `1` to skip the wrapper entirely (rollback path). |
| `CODEWIKI_DISABLE_HEARTBEAT` | unset | Set to `1` to disable the 30 s `runtime_heartbeat` stderr metric. |
| `CODEWIKI_HEARTBEAT_INTERVAL_MS` | `30000` | Override the heartbeat interval (milliseconds). |

The heartbeat metric line looks like:

```json
{"time":"...","level":"metric","msg":"runtime_heartbeat","value":1,"rssMb":188,"heapUsedMb":78,"heapTotalMb":140,"externalMb":42,"uptimeSec":127,"inFlightToolCount":0}
```

`inFlightToolCount` is incremented in `withMetrics` at handler entry and decremented in `finally` so throwing handlers cannot leak the count.

### Cross-platform graceful shutdown

On Linux/macOS the wrapper forwards `SIGTERM`/`SIGINT`/`SIGHUP` via `child.kill(sig)` — the child's POSIX signal handlers run `closer()` (driver + cache + watcher teardown). On Windows there is no POSIX signal delivery, so the wrapper opens a 4th-stdio-fd IPC channel and sends `{ type: 'codewiki-shutdown', signal }`; the child's `process.on('message', …)` listener runs the same `closer()`. 5 s grace window before force-kill. No platform-specific code anywhere else on the surface.

### Multi-instance awareness

When several MCP clients launch CodeWikiTap concurrently (a common pattern with multiple agents on the same machine), each instance writes a lock file under `<cache>/instances/<pid>.json` and warns on stderr if siblings are detected. This helps surface accidental N-instance situations that share the same on-disk cache and could otherwise compete for the embedder/reranker model load.

## stdio integrity (the most important invariant)

The stdio MCP transport reserves `process.stdout` for line-delimited JSON-RPC frames. A single non-JSON-RPC byte on stdout causes the client to report `-32000` and reconnect. This invariant is enforced at multiple levels:

- ESLint's `no-console` rule rejects `console.*` in `src/`. All structured logs go to **stderr** via a JSON logger (`src/logging.ts`), with a copy persisted to `${XDG_STATE_HOME:-~/.local/state}/codewiki-mcp/server.log` (rotated).
- The opt-in `CODEWIKI_STDOUT_TRIPWIRE=1` flag installs a side-observe wrapper around `process.stdout.write` that emits a warn-log if a non-JSON-RPC byte ever appears. It never reroutes the bytes — only observes.
- Boundary test `assertStdoutPureDuring()` exercises libraries that may print (Playwright, transformers.js progress callbacks, JSON pretty-printers) and asserts captured stdout is empty.

If you ever see `-32000` from the MCP client, the cause is almost always (1) a stalled Playwright install on first boot, or (2) a newly-added library writing a banner to stdout.

---

Next: [The 5 tools](/guide/tools) — the API surface exposed to the agent.
