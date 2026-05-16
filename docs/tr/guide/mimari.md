# Mimari

Üç şey, çoğu arka planda.

## 1. Boot — bu proje neye bağımlı, bul

```
   npx codewikitap çalışır
          │
          ▼
   cwd → $HOME arası yukarı yürür  (max 32 seviye, $HOME'u asla aşmaz)
          │
          ▼
   Manifest'i öncelik sırasına göre yakala:
     pom.xml › *.sln › *.csproj › Cargo.toml › composer.json
       › go.work › go.mod › pyproject.toml › package.json › Gemfile.lock
          │
          ▼
   Direct dep'leri parse et  +  workspace member'lar  +  BOM'lar  +  <parent> POM'lar
   (untrusted-input hardening: lstat, 1 MB cap, NUL-byte reject, symlink follow yok)
          │
          ▼
   Her dep → owner/repo  (cache 7 gün)
          │
          ▼
   Her repo için CodeWiki kapsamı yokla  (cache 24 saat, SHA-anchored)
          │
          ▼
   chokidar watcher: manifest + workspace member + aux file'lara abone
   (sonradan gelen `pnpm add foo` server'ı restart'lamadan yakalanır)
```

## 2. Index — sayfaları aranabilir chunk'lara çevir (lazy)

`find_chunks` veya `find_neighbors` bir repo'ya ilk değdiğinde, indexer o repo için **bir kez**, atomik şekilde çalışır:

```
   Repo'nun CodeWiki sayfa index'i
          │
          ▼
   getPage(repo, slug)  her sayfa için  (Playwright → DOM → canonical tree)
          │
          ├──► chunker         — heading-section başına, sadece leaf değil
          ├──► graph_extractor — aynı tree'den 5 edge tipi
          └──► embedder        — bge-small-en-v1.5 ONNX, lazy-load
          │
          ▼
   ┌───────────────────── SQLite transaction ─────────────────────┐
   │  INSERT chunks        (text + sayfa metadata)                 │
   │  INSERT vec_chunks    (sqlite-vec cosine virtual table)       │
   │  INSERT fts_chunks    (FTS5 virtual table)                    │
   │  INSERT kg_edges      (code_ref · diagram_edge · diagram_     │
   │                        member · section_link · cross_repo_ref)│
   │  UPDATE wiki_index_status                                     │
   └───────────────────────────────────────────────────────────────┘
          │
          ▼
   `get_page({ repo, prepareOnly: true })`, agent'a bir repo'yu önceden
   indeksleme imkânı verir; böylece ilk gerçek sorgu indexer'ın
   build deadline'ı ile yarışmaz.
```

Indexer **per-repo single-flight**'tır — eşzamanlı çağrılar tek bir in-flight promise'e toplanır. Tazelik `wiki_index_status.indexed_at` ve `CODEWIKI_INDEX_TTL_MS` (varsayılan 24 saat) üzerinden yönetilir. TTL geçmiş ama upstream `commit_sha` aynıysa yalnız zaman damgası tazelenir; SHA değişmişse tam rebuild çalışır.

## 3. Query — soruya cevap üret

```
   Agent → find_chunks({ query: "...", repos: [...] })
          │
          ▼
   Indexer.indexRepo() vs INDEX_BUILD_TIMEOUT_MS yarışı  (varsayılan 15 sn)
          │
          ▼
   ┌────────────┐      ┌────────────┐
   │  BM25      │      │   Dense    │      ← paralel
   │  FTS5      │      │ sqlite-vec │
   └─────┬──────┘      └─────┬──────┘
         └─── RRF fusion (k=60) ───┘
                       │
                       ▼
            Top CODEWIKI_RERANK_TOP_N aday  (varsayılan 50)
                       │
                       ▼
            Cross-encoder reranker  (ms-marco-MiniLM-L-6-v2)
                       │
                       ▼
            Top-K chunk şu alanlarla:
              { text, title, slug, citationUrl, commitSha,
                vectorRank, vectorScore,
                bm25Rank,   bm25Score,
                rrfScore,   rerankScore }
```

Index deadline içinde hazır değilse çağrı anında `status: 'index_building'` döner ve build arka planda sürer — bir sonraki çağrı warm index'e gelir. Reranker başarısız olursa (download timeout, runtime error, circuit breaker açık) sonuç yine döner — sadece vector benzerliğine göre sıralı ve `degraded: true` ile etiketli olarak, daha az hassas bir sıralamayla.

## Native bağımlılıklar ve fallback'ler

İki native dependency `package.json`'da **opsiyonel** olarak tanımlı:

| Native dep | Yokken | Etki |
|---|---|---|
| `better-sqlite3` | macOS/Windows prebuilt yoksa + toolchain yok | In-memory cache fallback; `cache.db` diskte yok. Sorgular çalışır, restart cache'i kaybeder. |
| `sqlite-vec` | macOS SIP, sandbox, Windows ARM, Alpine musl | `vector_store.ts` pure-JS cosine fallback. Büyük repolarda ~5–10× yavaş vektör sorgusu; sıralama matematik olarak eşdeğer. |

Boot sırasında tek satır structured stderr log:

```json
{"level":"info","msg":"runtime_capabilities","betterSqlite3":true,"sqliteVec":false,"playwright":"ready","nodeVersion":"22.5.0",...}
```

`sqlite-vec` varken bile pure-JS cosine yolunu zorlayabilirsin: `CODEWIKI_FORCE_PUREJS_VECTOR=1` — native extension'ın bir terslik yaptığından şüphelendiğinde işine yarar.

## Kaynak yönetimi

Bin entry başlangıçta `process.execArgv` içinde `--max-old-space-size` yoksa kendini bir defaya mahsus `--max-old-space-size=1536` ile re-exec eder. 7.5 GB / 2 GB-swap host'larda bu, repeated `find_chunks` yükünde Linux OOM-killer'ın server child'ını `SIGKILL`'lemesini durdurur. Wrapper stdio'yu inherit eder, böylece MCP JSON-RPC transport'u etkilenmez; child çıkınca wrapper PID anında ölür.

Operator escape hatch'leri:

| Env var | Varsayılan | Etki |
|---------|-----------|------|
| `CODEWIKI_NODE_HEAP_MB` | `1536` | Heap cap'i (MB) override et. |
| `CODEWIKI_DISABLE_HEAP_CAP` | unset | `1` yaparsan wrapper tamamen atlanır (rollback). |
| `CODEWIKI_DISABLE_HEARTBEAT` | unset | `1` yaparsan 30 sn'lik `runtime_heartbeat` stderr metric'i kapanır. |
| `CODEWIKI_HEARTBEAT_INTERVAL_MS` | `30000` | Heartbeat aralığını (ms) override et. |

Heartbeat metric line örneği:

```json
{"time":"...","level":"metric","msg":"runtime_heartbeat","value":1,"rssMb":188,"heapUsedMb":78,"heapTotalMb":140,"externalMb":42,"uptimeSec":127,"inFlightToolCount":0}
```

`inFlightToolCount` `withMetrics` handler entry'sinde artar, `finally` blok'unda azalır — fırlatan handler'lar sayacı leak etmez.

### Cross-platform graceful shutdown

Linux/macOS'ta wrapper `SIGTERM`/`SIGINT`/`SIGHUP`'ı `child.kill(sig)` ile forward eder — child'ın POSIX sinyal handler'ları `closer()` (driver + cache + watcher kapanışı) çalıştırır. Windows'ta POSIX sinyal teslimi olmadığı için wrapper 4. stdio fd üzerinde IPC channel açar ve `{ type: 'codewiki-shutdown', signal }` mesajı gönderir; child'ın `process.on('message', …)` listener'ı aynı `closer()` yolunu çalıştırır. 5 sn grace, sonra force-kill. Yüzeyin başka hiçbir yerinde platform-spesifik kod yok.

### Çok-instance farkındalığı

Birden fazla MCP client'ı aynı makinede CodeWikiTap'i eşzamanlı başlattığında (birden fazla agent'la sık karşılaşılan bir senaryo), her instance `<cache>/instances/<pid>.json` altında bir lock file yazar ve kardeş PID'leri tespit ederse stderr'e uyarı düşer. Bu, aynı disk cache'ini paylaşıp embedder/reranker model yüklemesinde yarışan kazara N-instance durumlarını fark etmeyi kolaylaştırır.

## stdio bütünlüğü (en önemli invariant)

stdio MCP transport'u `process.stdout`'u line-delimited JSON-RPC frame'lere ayırır. Stdout'a çıkan tek bir non-JSON-RPC byte, client'ın `-32000` rapor edip yeniden bağlanmasına yol açar. Bu invariant birçok seviyede zorlanır:

- ESLint'in `no-console` kuralı `src/` içinde `console.*` çağrılarını reddeder. Tüm structured log'lar **stderr**'e JSON logger (`src/logging.ts`) üzerinden gider; ayrıca `${XDG_STATE_HOME:-~/.local/state}/codewiki-mcp/server.log`'a (rotated) kopyalanır.
- Opt-in `CODEWIKI_STDOUT_TRIPWIRE=1`, `process.stdout.write` etrafına side-observe wrapper kurar; non-JSON-RPC byte'ı stdout'ta görürse warn-log atar. Asla yönlendirmez — yalnız gözlemler.
- Boundary test'i `assertStdoutPureDuring()`, yazabilen kütüphaneleri (Playwright, transformers.js progress callback, JSON pretty-printer) çalıştırır ve captured stdout'un boş olduğunu assert eder.

MCP client'tan `-32000` geliyorsa sebep neredeyse her zaman (1) ilk boot'ta takılan Playwright install, veya (2) yeni eklenmiş bir kütüphanenin stdout'a banner yazması.

---

Sıradaki: [5 araç](/tr/guide/araclar) — agent'a sunulan API yüzeyi.
