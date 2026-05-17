# Yapılandırma

Çoğu durumda varsayılanlar yeterlidir. Aşağıdaki değişkenler alana göre gruplanmıştır; gerçekten elinizi atmak isteyebileceğiniz olanlar **★** ile işaretli.

## Loglama

| Değişken | Varsayılan | Etki |
|---|---|---|
| **★** `LOG_LEVEL` | `info` | stderr log seviyesi (`debug` / `info` / `warn` / `error`). |

## Proje taraması

| Değişken | Varsayılan | Etki |
|---|---|---|
| **★** `CODEWIKI_INCLUDE_DEV_DEPS` | kapalı | `devDependencies` de taransın (test araçlarının dokümantasyonu lazım olduğunda). |
| **★** `CODEWIKI_DISABLE_WATCH` | kapalı | Manifest değişiklikleri izlenmesin (CI/CD için uygun). |
| `CODEWIKI_SCAN_MAX_DEPTH` | `8` | `list_project_dependencies` özyinelemeli alt klasör taraması için BFS derinlik üst sınırı. |
| `CODEWIKI_MAX_WALK_DEPTH` | `32` | cwd'den `$HOME`'a doğru manifest ararken yukarı yürüme derinliği. |
| `CODEWIKI_MAX_MANIFEST_BYTES` | `1048576` | Manifest dosyası için byte üst sınırı (untrusted-input önlemi). |
| `CODEWIKI_MAX_WORKSPACE_MEMBERS` | `256` | Proje başına workspace üye sayısı üst sınırı. |
| `CODEWIKI_MAX_WATCHED_PATHS` | `512` | chokidar izleme listesi üst sınırı. |
| `CODEWIKI_MAX_BOM_DEPTH` | `5` | Maven BOM özyineleme derinliği (döngüye karşı korumalı). |

## Önbellek süreleri

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_PAGE_TTL_MS` | `86400000` (24 saat) | Bir CodeWiki sayfası SHA kontrolünden önce ne kadar taze sayılır. |
| `CODEWIKI_REPO_TTL_MS` | `604800000` (7 gün) | Ad → `owner/repo` çözümlemesi ne kadar taze sayılır. |
| `CODEWIKI_WIKI_STATUS_TTL_MS` | `86400000` (24 saat) | Depo başına kapsam kontrolü ne kadar taze sayılır. |
| `CODEWIKI_FORCE_INMEMORY` | kapalı | Bellek içi önbelleği zorla (`better-sqlite3` yüklü olsa bile atla). |

## HTTP ve Playwright

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_MAX_CONCURRENT_PAGES` | `3` | Kaynak başına eşzamanlı Playwright sayfa yükleme üst sınırı. |
| `CODEWIKI_RATE_LIMIT_INTERVAL_MS` | `4000` | Kaynak başına ardışık sayfa yüklemeleri arasındaki en az süre. |
| `CODEWIKI_PAGE_LOAD_TIMEOUT_MS` | `30000` | Sayfa başına wall-clock üst sınırı. |
| `CODEWIKI_FETCH_TIMEOUT_MS` | `5000` | Playwright dışı HTTP istek zaman aşımı. |
| **★** `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS` | `180000` | Açılışta çalışan `npx playwright install` için wall-clock üst sınırı. |

## Arama (RAG)

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_EMBED_MODEL` | `Xenova/bge-small-en-v1.5` | ONNX gömme modeli. |
| `CODEWIKI_EMBED_MODEL_DIM` | `384` | Gömme boyutu. Modelle eşleşmek zorundadır. |
| `CODEWIKI_CHUNK_MAX_TOKENS` | `512` | Parça başına en fazla token. |
| `CODEWIKI_CHUNK_OVERLAP_TOKENS` | `64` | Parça çakışma payı. |
| `CODEWIKI_INDEX_TTL_MS` | `86400000` (24 saat) | Depo başına indeks ne kadar geçerli (SHA kontrolünden önce). |
| `CODEWIKI_INDEX_BUILD_TIMEOUT_MS` | `15000` | `find_chunks`'ın indeksleyiciye karşı yarıştığı zaman sınırı. Aşılırsa `status: 'index_building'` döner. |
| `CODEWIKI_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | ONNX cross-encoder yeniden sıralayıcı. |
| **★** `CODEWIKI_RERANK_TOP_N` | `50` | Yeniden sıralayıcıya verilen aday sayısı. |
| `CODEWIKI_RERANK_DOWNLOAD_TIMEOUT_MS` | `15000` | Yeniden sıralayıcı modeli indirme zaman aşımı. |
| `CODEWIKI_RERANKER_CIRCUIT_BREAKER_MS` | `60000` | Yeniden sıralayıcı hatasından sonra tekrar denemeye kadar bekleme süresi. |
| **★** `CODEWIKI_FORCE_NO_BM25` | kapalı | Yalnız vektör modu (BM25 dalı atlanır). |
| **★** `CODEWIKI_FORCE_PUREJS_VECTOR` | kapalı | `sqlite-vec` yüklü olsa bile saf JS cosine'ı zorla. |
| `CODEWIKI_RRF_K` | `60` | Reciprocal Rank Fusion `k` sabiti. |
| **★** `CODEWIKI_DISABLE_MODEL_WARMUP` | kapalı | Açılışta yapılan embedder + yeniden sıralayıcı ön ısıtmasını atla. |
| **★** `CODEWIKI_DISABLE_KG` | kapalı | Bilgi grafı inşasını atla; `find_neighbors` tamamen kayıttan düşer. |

## Kaynak yönetimi ve metrikler

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_NODE_HEAP_MB` | `1536` | V8 old-space heap üst sınırı (kendi kendini yeniden başlatan sarmalayıcı). |
| `CODEWIKI_DISABLE_HEAP_CAP` | kapalı | Heap üst sınırı sarmalayıcısını tamamen atla (geri dönüş yolu). |
| `CODEWIKI_HEARTBEAT_INTERVAL_MS` | `30000` | `runtime_heartbeat` stderr metriğinin aralığı. |
| `CODEWIKI_DISABLE_HEARTBEAT` | kapalı | Heartbeat metriğini kapat. |
| `CODEWIKI_METRIC_AGGREGATE` | kapalı | `tool_latency_ms` satırlarını çağrı başına değil, toplu olarak yay. |
| `CODEWIKI_METRIC_FLUSH_INTERVAL_MS` | `30000` | Toplu metrik gönderim aralığı. |

## Tanılama

| Değişken | Varsayılan | Etki |
|---|---|---|
| `CODEWIKI_STDOUT_TRIPWIRE` | kapalı | stdout etrafında yalnız gözlem yapan sarmalayıcı; JSON-RPC dışı byte'larda uyarır. Asla yön değiştirmez. |

## Sorun giderme

### Soğuk başlangıçta MCP `-32000`

`npx codewikitap`'in ilk çalıştırmasında MCP istemcisi `-32000` raporu veriyor ve yeniden bağlanıyor.

**Sebep:** Çoğu zaman codewikitap sürecinin içinde takılan ya da reddedilen `npx playwright install --only-shell chromium` (kurumsal proxy, çevrimdışı sandbox, npm registry'ye erişim yok).

**Çözüm:**

1. Kurulumu bir kerelik elinizle çalıştırın:

   ```bash
   npx playwright install --only-shell chromium
   ```

2. codewikitap'i yeniden başlatın. Sonraki çalıştırmalar diskteki ikiliyi kullanır ve `transport.connect()`'e milisaniyeler içinde ulaşır.

3. Kurulum başarısız oluyorsa ve tarayıcı kullanan araçlar düşük performansla bile olsa hemen ayağa kalksın istiyorsanız `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS=5000` verin. MCP el sıkışması başarılı olur; tarayıcı kullanan araçlar (`get_page`, `find_chunks` önbellek dışı, `find_neighbors` önbellek dışı) kurulum bitene kadar `rate_limited` zarfı döndürür. Tarayıcı kullanmayan araçlar (`list_project_dependencies`, `resolve_repo`) bundan etkilenmez.

### `sqliteVec: false` ve sorgular yavaş

Açılıştaki `runtime_capabilities` log satırı `sqliteVec: false` gösteriyor.

**Sebep:** `sqlite-vec` yerel uzantısı platformunuza kurulamadı (macOS SIP, sandbox'lı konteyner, Windows ARM, Alpine musl prebuilt'i kırar).

**Çözüm:** Uyumlu prebuilt'i yükleyin ya da kaynağından derleyin:

```bash
npm rebuild sqlite-vec
```

Vektör sıralaması yine çalışır (`vector_store.ts` saf JS cosine yedek yoluna döner) — yalnızca büyük depolarda ~5–10 kat daha yavaş olur. Matematik eşdeğer.

### `betterSqlite3: false` ve yeniden başlatma önbelleği kaybediyor

`runtime_capabilities` log satırı `betterSqlite3: false` gösteriyor.

**Sebep:** `better-sqlite3` opsiyonel yerel bağımlılıktır; platformunuzun prebuilt'i ve C++ toolchain'iniz yoksa kurulum atlanır.

**Etki:** Bellek içi önbellek devreye girer; sorgular çalışır ama yeniden başlatma her şeyi sıfırlar (parçalar, vektörler, bilgi grafı bağlantıları).

**Çözüm:** Platformunuza uygun prebuilt'i yükleyin ya da derleme araçlarını (Xcode CLI / VS Build Tools / `apt install build-essential`) kurup `pnpm install`'ı yeniden çalıştırın.

### Çok sayıda depoyu toplu indekslemek yavaş hissettiriyor

CodeWiki aktif bot tespitli bir Angular SPA. CodeWikiTap, kaynak başına 4 saniyede 1 sayfa kuralını kendi tarafında uygular (`CODEWIKI_RATE_LIMIT_INTERVAL_MS=4000`). Olağan etkileşimli kullanımda bu hissedilmez; toplu indeksleme yaptığınızda hissedilir.

Aynı anda birçok depoyu indeksliyorsanız `get_page({ prepareOnly: true })` çağrılarıyla ön ısıtın — sonraki `find_chunks` istekleri sıcak indekse gelir.

### "MCP sunucusu kayıtlı ama agent araçları görmüyor"

Yapılandırma dosyası yazıldı ama agent yeniden yüklenmedi. Agent'ı tamamen kapatıp yeniden açın (yalnız pencereyi kapatmak yetmeyebilir — bazı agent'lar MCP sunucu listesini oturum boyunca önbelleğe alır).

---

Bu kadar. Bu kılavuzun kapsamadığı şeyler için kaynak [GitHub](https://github.com/burakarslan0110/codewikitap-mcp)'da; [CHANGELOG](https://github.com/burakarslan0110/codewikitap-mcp/blob/main/CHANGELOG.md) her sürümü takip eder.
