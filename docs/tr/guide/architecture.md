# Mimari

Üç temel aşama, büyük kısmı arka planda.

## 1. Açılış — bu proje neye bağımlı, bul

```
   npx codewikitap çalışır
          │
          ▼
   cwd'den $HOME'a doğru yukarı yürür  (en fazla 32 seviye, $HOME'u asla aşmaz)
          │
          ▼
   Manifest'i öncelik sırasına göre yakala:
     pom.xml › *.sln › *.csproj › Cargo.toml › composer.json
       › go.work › go.mod › pyproject.toml › package.json › Gemfile.lock
          │
          ▼
   Doğrudan bağımlılıkları ayrıştır  +  workspace üyeleri  +  BOM'lar  +  <parent> POM'lar
   (untrusted-input önlemleri: lstat, 1 MB sınır, NUL byte reddi, symlink takibi yok)
          │
          ▼
   Her bağımlılık → owner/repo  (önbellek 7 gün)
          │
          ▼
   Her depo için CodeWiki kapsamı kontrol et  (önbellek 24 saat, SHA'ya bağlı)
          │
          ▼
   chokidar izleyicisi: manifest + workspace üyeleri + yardımcı dosyalara abone
   (sonradan çalıştırılan `pnpm add foo`, sunucu yeniden başlatılmadan algılanır)
```

## 2. İndeksleme — sayfaları aranabilir parçalara çevir (tembel)

`find_chunks` ya da `find_neighbors` bir depoya ilk değdiğinde, indeksleyici o depo için **bir kere**, atomik biçimde çalışır:

```
   Deponun CodeWiki sayfa listesi
          │
          ▼
   getPage(repo, slug)  her sayfa için  (Playwright → DOM → canonical tree)
          │
          ├──► chunker         — başlık bölümü başına, sadece leaf değil
          ├──► graph_extractor — aynı ağaçtan 5 bağlantı türü
          └──► embedder        — bge-small-en-v1.5 ONNX, tembel yüklenir
          │
          ▼
   ┌───────────────────── SQLite işlemi ──────────────────────────┐
   │  INSERT chunks        (metin + sayfa metadata'sı)             │
   │  INSERT vec_chunks    (sqlite-vec cosine virtual table)       │
   │  INSERT fts_chunks    (FTS5 virtual table)                    │
   │  INSERT kg_edges      (code_ref · diagram_edge · diagram_     │
   │                        member · section_link · cross_repo_ref)│
   │  UPDATE wiki_index_status                                     │
   └───────────────────────────────────────────────────────────────┘
          │
          ▼
   `get_page({ repo, prepareOnly: true })`, agent'ın bir depoyu önceden
   indekslemesine olanak verir; böylece ilk gerçek sorgu indeksleyicinin
   zaman sınırına yakalanmaz.
```

İndeksleyici **depo başına tek koşumdur** — eşzamanlı çağrılar tek bir bekleyen promise'e toplanır. Tazelik `wiki_index_status.indexed_at` ve `CODEWIKI_INDEX_TTL_MS` (varsayılan 24 saat) üzerinden yönetilir. TTL geçmiş ama üst kaynaktaki commit aynıysa yalnızca zaman damgası tazelenir; commit değişmişse tam yeniden inşa çalışır.

## 3. Sorgu — soruya cevap üret

```
   Agent → find_chunks({ query: "...", repos: [...] })
          │
          ▼
   Indexer.indexRepo() ile INDEX_BUILD_TIMEOUT_MS yarışı  (varsayılan 15 sn)
          │
          ▼
   ┌────────────┐      ┌────────────┐
   │  BM25      │      │   Dense    │      ← paralel
   │  FTS5      │      │ sqlite-vec │
   └─────┬──────┘      └─────┬──────┘
         └─── RRF füzyonu (k=60) ──┘
                       │
                       ▼
            En alakalı CODEWIKI_RERANK_TOP_N aday  (varsayılan 50)
                       │
                       ▼
            Cross-encoder ile yeniden sıralama  (ms-marco-MiniLM-L-6-v2)
                       │
                       ▼
            En üst K parça şu alanlarla:
              { text, title, slug, citationUrl, commitSha,
                vectorRank, vectorScore,
                bm25Rank,   bm25Score,
                rrfScore,   rerankScore }
```

İndeks zaman sınırı içinde hazır değilse çağrı anında `status: 'index_building'` döner ve inşa arka planda sürer — bir sonraki çağrı sıcak indekse gelir. Yeniden sıralayıcı başarısız olursa (indirme zaman aşımı, çalışma zamanı hatası, devre kesici açık) sonuç yine döner — sadece vektör benzerliğine göre sıralı ve `degraded: true` etiketiyle birlikte, biraz daha kaba bir sıralamayla.

## Yerel (native) bağımlılıklar ve yedek yollar

İki yerel bağımlılık `package.json`'da **opsiyonel** olarak tanımlıdır:

| Yerel bağımlılık | Yokken | Etki |
|---|---|---|
| `better-sqlite3` | macOS/Windows prebuilt'i yok ve toolchain'iniz yoksa | Bellek içi önbelleğe geçilir; `cache.db` diske düşmez. Sorgular çalışır, yeniden başlatma önbelleği kaybeder. |
| `sqlite-vec` | macOS SIP, sandbox, Windows ARM, Alpine musl | `vector_store.ts` saf JS cosine yedek yoluna döner. Büyük depolarda vektör sorgusu ~5–10 kat yavaş; sıralama matematiksel olarak eşdeğer. |

Açılışta tek satırlık yapılandırılmış bir stderr log'u atılır:

```json
{"level":"info","msg":"runtime_capabilities","betterSqlite3":true,"sqliteVec":false,"playwright":"ready","nodeVersion":"22.5.0",...}
```

`sqlite-vec` mevcut olsa bile saf JS cosine yolunu zorlamak istiyorsanız: `CODEWIKI_FORCE_PUREJS_VECTOR=1` — yerel uzantının ters bir şey yaptığından şüphelendiğinizde işe yarar.

## Kaynak yönetimi

Bin giriş noktası, açılışta `process.execArgv` içinde `--max-old-space-size` yoksa kendini bir kereliğine `--max-old-space-size=1536` ile yeniden başlatır. 7.5 GB RAM / 2 GB swap'lı sunucularda bu, tekrarlanan `find_chunks` yükü altında Linux OOM-killer'ın sunucu alt sürecini `SIGKILL`'lemesini engeller. Sarmalayıcı stdio'yu olduğu gibi devreder, dolayısıyla MCP JSON-RPC trafiği etkilenmez; alt süreç çıkınca sarmalayıcı PID anında ölür.

Operatör için kaçış kapıları:

| Ortam değişkeni | Varsayılan | Etki |
|---------|-----------|------|
| `CODEWIKI_NODE_HEAP_MB` | `1536` | Heap üst sınırını (MB) değiştir. |
| `CODEWIKI_DISABLE_HEAP_CAP` | unset | `1` verirseniz sarmalayıcı tamamen atlanır (geri dönüş yolu). |
| `CODEWIKI_DISABLE_HEARTBEAT` | unset | `1` verirseniz 30 saniyelik `runtime_heartbeat` stderr metriği kapanır. |
| `CODEWIKI_HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat aralığını (ms) değiştir. |

Heartbeat metrik satırı örneği:

```json
{"time":"...","level":"metric","msg":"runtime_heartbeat","value":1,"rssMb":188,"heapUsedMb":78,"heapTotalMb":140,"externalMb":42,"uptimeSec":127,"inFlightToolCount":0}
```

`inFlightToolCount`, `withMetrics` handler'ı giriş yaptığında artar ve `finally` bloğunda azalır — hata fırlatan handler'lar sayacı sızdırmaz.

### Platformlar arası temiz kapanış

Linux/macOS'ta sarmalayıcı `SIGTERM`/`SIGINT`/`SIGHUP` sinyallerini `child.kill(sig)` ile alt sürece iletir; alt sürecin POSIX sinyal handler'ları `closer()` fonksiyonunu (driver + önbellek + izleyici kapanışı) çalıştırır. Windows'ta POSIX sinyal teslimi olmadığı için sarmalayıcı 4. stdio fd üzerinde bir IPC kanalı açar ve `{ type: 'codewiki-shutdown', signal }` mesajını gönderir; alt sürecin `process.on('message', …)` dinleyicisi aynı `closer()` yolunu çalıştırır. 5 saniyelik bir tolerans, ardından zorla kapatma. Yüzeyin başka hiçbir yerinde platforma özel kod yoktur.

### Çoklu örnek farkındalığı

Aynı bilgisayarda birden çok MCP istemcisi CodeWikiTap'i eşzamanlı başlattığında (birden çok agent kullanırken sık karşılaşılan bir durum), her örnek `<cache>/instances/<pid>.json` altına bir kilit dosyası yazar ve kardeş PID'leri tespit ederse stderr'e uyarı düşer. Bu, aynı disk önbelleğini paylaşıp embedder/yeniden sıralayıcı model yüklemesinde yarışan kazara N-örnek durumlarını fark etmeyi kolaylaştırır.

## stdio bütünlüğü (en önemli değişmez)

stdio MCP transport'u `process.stdout`'u satır satır JSON-RPC çerçevelerine ayırır. stdout'a çıkan tek bir JSON-RPC dışı byte bile, istemcinin `-32000` raporu verip yeniden bağlanmasına yol açar. Bu değişmez birçok seviyede korunur:

- ESLint'in `no-console` kuralı `src/` içinde `console.*` çağrılarını reddeder. Tüm yapılandırılmış loglar **stderr'e**, JSON logger (`src/logging.ts`) üzerinden gider; ayrıca `${XDG_STATE_HOME:-~/.local/state}/codewiki-mcp/server.log` dosyasına (döndürülerek) kopyalanır.
- Opt-in olarak `CODEWIKI_STDOUT_TRIPWIRE=1` verildiğinde `process.stdout.write` etrafına yalnız gözlem yapan bir sarmalayıcı kurulur; stdout'ta JSON-RPC dışı bir byte görürse uyarı log'u atar. Asla yön değiştirmez — yalnız gözler.
- `assertStdoutPureDuring()` adlı sınır testi, yazma eğilimi olan kütüphaneleri (Playwright, transformers.js progress callback, JSON pretty-printer) çalıştırır ve yakalanan stdout'un boş olduğunu doğrular.

MCP istemcisinden `-32000` geliyorsa sebep neredeyse her zaman ya (1) ilk açılışta takılan Playwright kurulumudur, ya da (2) yeni eklenmiş bir kütüphanenin stdout'a banner yazmasıdır.

---

Sıradaki: [5 araç](/tr/guide/tools) — agent'a sunulan API yüzeyi.
