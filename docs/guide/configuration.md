# Configuration

Defaults are sufficient for most cases. The variables below are organised by area; the ones you're most likely to reach for are marked **★**.

## Logging

| Variable | Default | Effect |
|---|---|---|
| **★** `LOG_LEVEL` | `info` | Stderr log verbosity (`debug` / `info` / `warn` / `error`). |

## Project scanning

| Variable | Default | Effect |
|---|---|---|
| **★** `CODEWIKI_INCLUDE_DEV_DEPS` | off | Also scan `devDependencies` (useful when test-tool docs matter). |
| **★** `CODEWIKI_DISABLE_WATCH` | off | Don't watch manifest changes (CI/CD friendly). |
| `CODEWIKI_SCAN_MAX_DEPTH` | `8` | Max BFS depth for recursive subdir scan in `list_project_dependencies`. |
| `CODEWIKI_MAX_WALK_DEPTH` | `32` | Max depth for the upward manifest walk from cwd toward `$HOME`. |
| `CODEWIKI_MAX_MANIFEST_BYTES` | `1048576` | Hard cap on manifest file size (untrusted-input hardening). |
| `CODEWIKI_MAX_WORKSPACE_MEMBERS` | `256` | Cap on workspace members per project. |
| `CODEWIKI_MAX_WATCHED_PATHS` | `512` | Cap on chokidar watch list size. |
| `CODEWIKI_MAX_BOM_DEPTH` | `5` | Maven BOM recursion depth limit (cycle-safe). |

## Cache TTLs

| Variable | Default | Effect |
|---|---|---|
| `CODEWIKI_PAGE_TTL_MS` | `86400000` (24 h) | How long a single CodeWiki page stays fresh before the SHA probe. |
| `CODEWIKI_REPO_TTL_MS` | `604800000` (7 d) | How long a name → `owner/repo` resolution stays fresh. |
| `CODEWIKI_WIKI_STATUS_TTL_MS` | `86400000` (24 h) | How long the per-repo coverage probe stays fresh. |
| `CODEWIKI_FORCE_INMEMORY` | off | Force in-memory cache (skip `better-sqlite3` even when available). |

## HTTP and Playwright

| Variable | Default | Effect |
|---|---|---|
| `CODEWIKI_MAX_CONCURRENT_PAGES` | `3` | Max concurrent Playwright page loads per origin. |
| `CODEWIKI_RATE_LIMIT_INTERVAL_MS` | `4000` | Per-origin minimum interval between page loads. |
| `CODEWIKI_PAGE_LOAD_TIMEOUT_MS` | `30000` | Per-page wall-clock cap. |
| `CODEWIKI_FETCH_TIMEOUT_MS` | `5000` | HTTP request timeout for non-Playwright fetches. |
| **★** `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS` | `180000` | Wallclock cap on the boot-time `npx playwright install`. |

## Retrieval (RAG)

| Variable | Default | Effect |
|---|---|---|
| `CODEWIKI_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | ONNX embedding model. |
| `CODEWIKI_EMBED_MODEL_DIM` | `384` | Embedding dimensionality. Must match the model. |
| `CODEWIKI_CHUNK_MAX_TOKENS` | `512` | Max tokens per chunk. |
| `CODEWIKI_CHUNK_OVERLAP_TOKENS` | `64` | Chunk overlap. |
| `CODEWIKI_INDEX_TTL_MS` | `86400000` (24 h) | How long a per-repo index stays valid before a SHA probe. |
| `CODEWIKI_INDEX_BUILD_TIMEOUT_MS` | `15000` | The race deadline `find_chunks` runs against the indexer. On timeout, returns `status: 'index_building'`. |
| `CODEWIKI_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | ONNX cross-encoder reranker. |
| **★** `CODEWIKI_RERANK_TOP_N` | `50` | Candidate count passed to the reranker. |
| `CODEWIKI_RERANK_DOWNLOAD_TIMEOUT_MS` | `15000` | Reranker model download timeout. |
| `CODEWIKI_RERANKER_CIRCUIT_BREAKER_MS` | `60000` | Cool-down before retrying after a reranker failure. |
| **★** `CODEWIKI_FORCE_NO_BM25` | off | Vector-only mode (BM25 branch skipped). |
| **★** `CODEWIKI_FORCE_PUREJS_VECTOR` | off | Force pure-JS cosine even when `sqlite-vec` is available. |
| `CODEWIKI_RRF_K` | `60` | Reciprocal Rank Fusion `k` constant. |
| **★** `CODEWIKI_DISABLE_MODEL_WARMUP` | off | Skip boot-time embedder + reranker warmup. |
| **★** `CODEWIKI_DISABLE_KG` | off | Skip knowledge graph build; `find_neighbors` is unregistered entirely. |

## Resource governance and metrics

| Variable | Default | Effect |
|---|---|---|
| `CODEWIKI_NODE_HEAP_MB` | `1536` | V8 old-space heap cap (self-reexec wrapper). |
| `CODEWIKI_DISABLE_HEAP_CAP` | off | Skip the heap-cap wrapper entirely (rollback). |
| `CODEWIKI_HEARTBEAT_INTERVAL_MS` | `30000` | Interval for the `runtime_heartbeat` stderr metric. |
| `CODEWIKI_DISABLE_HEARTBEAT` | off | Disable the heartbeat metric. |
| `CODEWIKI_METRIC_AGGREGATE` | off | Aggregate `tool_latency_ms` lines instead of emitting one per call. |
| `CODEWIKI_METRIC_FLUSH_INTERVAL_MS` | `30000` | Flush interval for aggregated metrics. |

## Diagnostics

| Variable | Default | Effect |
|---|---|---|
| `CODEWIKI_STDOUT_TRIPWIRE` | off | Side-observe wrapper around stdout; warns on non-JSON-RPC bytes. Never reroutes. |

## Troubleshooting

### MCP `-32000` on cold start

The very first run of `npx codewikitap` shows the MCP client reporting `-32000` and reconnecting.

**Cause:** usually a stalled or denied `npx playwright install --only-shell chromium` inside the codewikitap process (corporate proxy, offline sandbox, npm registry unreachable).

**Fix:**

1. Run the install manually once:

   ```bash
   npx playwright install --only-shell chromium
   ```

2. Restart codewikitap. Subsequent runs use the on-disk binary and reach `transport.connect()` within milliseconds.

3. If the install fails and you need the server to come up immediately with browser-using tools degraded, set `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS=5000`. The MCP handshake succeeds and browser tools (`get_page`, `find_chunks` cache-miss, `find_neighbors` cache-miss) return a `rate_limited` retry envelope until the install completes. Non-browser tools (`list_project_dependencies`, `resolve_repo`) work unaffected.

### `sqliteVec: false` and queries feel slow

The `runtime_capabilities` log line on boot shows `sqliteVec: false`.

**Cause:** the `sqlite-vec` native extension wasn't installed for your platform (macOS SIP, sandboxed container, Windows ARM, Alpine musl all break the prebuilt).

**Fix:** install the matching prebuilt or rebuild from source:

```bash
npm rebuild sqlite-vec
```

Vector ranking still works (pure-JS cosine in `vector_store.ts`) — it's just ~5–10× slower on large repos. The math is equivalent.

### `betterSqlite3: false` and the cache is lost across restarts

The `runtime_capabilities` log line shows `betterSqlite3: false`.

**Cause:** `better-sqlite3` is an optional native dep; on platforms without a published prebuilt and without a C++ toolchain, install skips it.

**Effect:** in-memory cache; queries still work, but restart loses everything (chunks, vectors, KG edges).

**Fix:** install the platform-matching prebuilt, or install a build toolchain (Xcode CLI / VS Build Tools / `apt install build-essential`) and rerun `pnpm install`.

### Bulk-indexing many repos at once feels slow

CodeWiki is an Angular SPA with active bot detection. CodeWikiTap self-throttles to **one page load per four seconds per origin** (`CODEWIKI_RATE_LIMIT_INTERVAL_MS=4000`). Typical interactive use never feels this; bulk-indexing many repos at once will.

If you're indexing many repos at once, pre-warm with `get_page({ prepareOnly: true })` calls so the actual `find_chunks` requests later hit warm indexes.

### "MCP server registered but agent doesn't see tools"

The config file was written but the agent didn't reload. Restart the agent (full quit, not just a window close — some agents cache MCP server lists for the session).

---

That's everything. For things this guide didn't cover, the source is on [GitHub](https://github.com/burakarslan0110/codewikitap-mcp) and the [CHANGELOG](https://github.com/burakarslan0110/codewikitap-mcp/blob/main/CHANGELOG.md) tracks every release.
