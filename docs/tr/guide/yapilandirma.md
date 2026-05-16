# Yapılandırma

Çoğu durumda varsayılanlar yeter. Aşağıdaki değişkenler alana göre gruplanmış; gerçekten elini atmak isteyebileceklerin **★** ile işaretli.

## Loglama

| Değişken | Varsayılan | Etki |
|---|---|---|
| **★** `LOG_LEVEL` | `info` | Stderr log seviyesi (`debug` / `info` / `warn` / `error`). |

## Proje taraması

| Değişken | Varsayılan | Etki |
|---|---|---|
| **★** `CODEWIKI_INCLUDE_DEV_DEPS` | kapalı | `devDependencies` de taransın (test tool dokümantasyonu gerektiğinde). |
| **★** `CODEWIKI_DISABLE_WATCH` | kapalı | Manifest değişikliği izlenmesin (CI/CD'ye uygun). |
| `CODEWIKI_SCAN_MAX_DEPTH` | `8` | `list_project_dependencies` recursive alt klasör tarama BFS derinlik üst sınırı. |
| `CODEWIKI_MAX_WALK_DEPTH` | `32` | cwd'den `$HOME`'a manifest aramada yukarı yürüme derinliği. |
| `CODEWIKI_MAX_MANIFEST_BYTES` | `1048576` | Manifest dosya boyutu üst sınırı (untrusted-input hardening). |
| `CODEWIKI_MAX_WORKSPACE_MEMBERS` | `256` | Proje başına workspace member sayısı üst sınırı. |
| `CODEWIKI_MAX_WATCHED_PATHS` | `512` | chokidar watch listesi üst sınırı. |
| `CODEWIKI_MAX_BOM_DEPTH` | `5` | Maven BOM recursion derinliği (cycle-safe). |

## Cache TTL'leri

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_PAGE_TTL_MS` | `86400000` (24 saat) | Tek CodeWiki sayfası SHA probe öncesi ne kadar taze kalır. |
| `CODEWIKI_REPO_TTL_MS` | `604800000` (7 gün) | Ad → `owner/repo` çözünürlüğü ne kadar taze kalır. |
| `CODEWIKI_WIKI_STATUS_TTL_MS` | `86400000` (24 saat) | Repo başına kapsam probe'u ne kadar taze kalır. |
| `CODEWIKI_FORCE_INMEMORY` | kapalı | In-memory cache zorla (`better-sqlite3` mevcut olsa bile atla). |

## HTTP ve Playwright

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_MAX_CONCURRENT_PAGES` | `3` | Origin başına eşzamanlı Playwright sayfa yükleme üst sınırı. |
| `CODEWIKI_RATE_LIMIT_INTERVAL_MS` | `4000` | Origin başına sayfa yüklemeleri arası minimum süre. |
| `CODEWIKI_PAGE_LOAD_TIMEOUT_MS` | `30000` | Sayfa başına wall-clock üst sınırı. |
| `CODEWIKI_FETCH_TIMEOUT_MS` | `5000` | Playwright dışı HTTP request timeout'u. |
| **★** `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS` | `180000` | Boot-time `npx playwright install` wallclock üst sınırı. |

## Retrieval (RAG)

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | ONNX embedding model. |
| `CODEWIKI_EMBED_MODEL_DIM` | `384` | Embedding boyutu. Model ile eşleşmeli. |
| `CODEWIKI_CHUNK_MAX_TOKENS` | `512` | Chunk başına max token. |
| `CODEWIKI_CHUNK_OVERLAP_TOKENS` | `64` | Chunk overlap. |
| `CODEWIKI_INDEX_TTL_MS` | `86400000` (24 saat) | Repo başına index ne kadar geçerli (SHA probe öncesi). |
| `CODEWIKI_INDEX_BUILD_TIMEOUT_MS` | `15000` | `find_chunks` indexer'a karşı yarıştığı deadline. Aşılırsa `status: 'index_building'` döner. |
| `CODEWIKI_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | ONNX cross-encoder reranker. |
| **★** `CODEWIKI_RERANK_TOP_N` | `50` | Reranker'a verilen aday sayısı. |
| `CODEWIKI_RERANK_DOWNLOAD_TIMEOUT_MS` | `15000` | Reranker model indirme timeout'u. |
| `CODEWIKI_RERANKER_CIRCUIT_BREAKER_MS` | `60000` | Reranker hatasından sonra retry'a kadar bekleme süresi. |
| **★** `CODEWIKI_FORCE_NO_BM25` | kapalı | Vector-only mod (BM25 dalı atlanır). |
| **★** `CODEWIKI_FORCE_PUREJS_VECTOR` | kapalı | `sqlite-vec` mevcut olsa bile pure-JS cosine zorla. |
| `CODEWIKI_RRF_K` | `60` | Reciprocal Rank Fusion `k` sabiti. |
| **★** `CODEWIKI_DISABLE_MODEL_WARMUP` | kapalı | Boot-time embedder + reranker warmup atla. |
| **★** `CODEWIKI_DISABLE_KG` | kapalı | Knowledge graph build atla; `find_neighbors` tamamen kayıttan düşer. |

## Kaynak yönetimi ve metric

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_NODE_HEAP_MB` | `1536` | V8 old-space heap cap (self-reexec wrapper). |
| `CODEWIKI_DISABLE_HEAP_CAP` | kapalı | Heap-cap wrapper'ı tamamen atla (rollback). |
| `CODEWIKI_HEARTBEAT_INTERVAL_MS` | `30000` | `runtime_heartbeat` stderr metric'inin aralığı. |
| `CODEWIKI_DISABLE_HEARTBEAT` | kapalı | Heartbeat metric'ini kapat. |
| `CODEWIKI_METRIC_AGGREGATE` | kapalı | `tool_latency_ms` satırlarını çağrı başına yerine agrega olarak yay. |
| `CODEWIKI_METRIC_FLUSH_INTERVAL_MS` | `30000` | Agrega metric flush aralığı. |

## Diagnostics

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_STDOUT_TRIPWIRE` | kapalı | Stdout etrafında side-observe wrapper; non-JSON-RPC byte'larda uyarır. Asla yönlendirmez. |

## Sorun giderme

### Cold start'ta MCP `-32000`

`npx codewikitap`'in ilk çalıştırmasında MCP client `-32000` rapor ediyor ve yeniden bağlanıyor.

**Sebep:** genellikle codewikitap process'inin içinde takılan veya reddedilen `npx playwright install --only-shell chromium` (corporate proxy, offline sandbox, npm registry erişilemez).

**Çözüm:**

1. Install'ı bir kerelik manuel çalıştır:

   ```bash
   npx playwright install --only-shell chromium
   ```

2. codewikitap'i yeniden başlat. Sonraki çalıştırmalar disk'teki binary'i kullanır ve `transport.connect()`'e milisaniyeler içinde ulaşır.

3. Install başarısız olur ve server'ı browser-using tool'lar degrade halde anında ayağa kaldırman gerekirse `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS=5000` set et. MCP handshake başarılı olur; browser tool'ları (`get_page`, `find_chunks` cache-miss, `find_neighbors` cache-miss) install bitene kadar `rate_limited` retry envelope döner. Browser kullanmayan tool'lar (`list_project_dependencies`, `resolve_repo`) etkilenmez.

### `sqliteVec: false` ve sorgular yavaş

Boot'taki `runtime_capabilities` log satırı `sqliteVec: false` gösteriyor.

**Sebep:** `sqlite-vec` native extension platforma uygun şekilde kurulamadı (macOS SIP, sandboxed container, Windows ARM, Alpine musl prebuilt'i kırar).

**Çözüm:** uyumlu prebuilt'i yükle veya kaynağından derle:

```bash
npm rebuild sqlite-vec
```

Vector ranking yine çalışır (`vector_store.ts` pure-JS cosine) — büyük repolarda ~5–10× daha yavaştır sadece. Matematik eşdeğer.

### `betterSqlite3: false` ve restart cache'i kaybediyor

`runtime_capabilities` log satırı `betterSqlite3: false` gösteriyor.

**Sebep:** `better-sqlite3` opsiyonel native dep'tir; platformun prebuilt'i ve C++ toolchain'i yoksa install atlar.

**Etki:** In-memory cache; sorgular çalışır, ama restart her şeyi kaybeder (chunks, vectors, KG edges).

**Çözüm:** Platformuna uygun prebuilt'i yükle veya build toolchain'i (Xcode CLI / VS Build Tools / `apt install build-essential`) kur ve `pnpm install`'ı tekrar çalıştır.

### Birçok repo'yu bulk indexlemek yavaş hissediyor

CodeWiki aktif bot detection'lı bir Angular SPA. CodeWikiTap origin başına 4 saniyede 1 sayfa yükleme limitini kendi tarafında uygular (`CODEWIKI_RATE_LIMIT_INTERVAL_MS=4000`). Tipik interaktif kullanımda hissedilmez; bulk-indeksleme yaparken hissedilir.

Aynı anda birçok repo indeksliyorsan, `get_page({ prepareOnly: true })` çağrılarıyla ön-ısıt — böylece sonraki `find_chunks` istekleri warm index'e gelir.

### "MCP server kayıtlı ama agent tool'ları görmüyor"

Config dosyası yazıldı ama agent yeniden yüklenmedi. Agent'ı tamamen kapat ve yeniden aç (sadece pencereyi kapatma yetmeyebilir — bazı agent'lar MCP server listesini session için cache'ler).

---

Bu kadar. Bu kılavuzun kapsamadığı şeyler için kaynak [GitHub](https://github.com/burakarslan0110/codewikitap-mcp)'da; [CHANGELOG](https://github.com/burakarslan0110/codewikitap-mcp/blob/main/CHANGELOG.md) her sürümü takip eder.
