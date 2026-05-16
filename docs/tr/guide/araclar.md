# 5 araç

Bunları sen çağırmazsın — agent çağırır. Liste bilerek kısa tutulmuş; her birinin ne yaptığını bilmek agent'ın muhakemesini okurken işe yarar.

::: tip Kilitli yüzey
Server tam olarak **beş tool** kaydeder. `buildServer()` içindeki regex `search`, `ask`, `query`, `generate`, `index`, `write` içeren her ismi reddeder — hiçbir plugin veya hook API'yi sessizce genişletemez. `get_page` tek non-readonly tool'dur (`prepareOnly: true` branch'i HTTP fetch + sqlite write yapar).
:::

## 1. `list_project_dependencies` — temel

Session başında, otomatik, bir kez çağrılır. Agent ilk düşüncesinden önce tam kapsam raporunu alır.

```
   Session başı
        │
        ▼
   Manifest tara  ──►  Repo çöz  ──►  CodeWiki kapsamı yokla
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

## 2. `resolve_repo` — ad → `owner/repo`

Agent slug'ı zaten biliyorsa atlanır. Kullanıcı "react'in dokümanına bak" dediğinde resolver `react` → `facebook/react` map'ini yapar.

```
   "react"  ─►  npm registry  ─►  repository.url  ─►  facebook/react
   "lodash" ─►  npm           ─►  github.com/...  ─►  lodash/lodash
   "rails"  ─►  RubyGems      ─►  source_code_uri ─►  rails/rails
```

Registry'de GitHub repository URL'i yoksa `status: "no_match"` döner.

## 3. `get_page` — sayfa, sub-section, içindekiler veya pre-warm

Tek bir tool'dan üç mod:

```
   Input:  { owner, repo, slug?, subsection?, listPages?, prepareOnly? }
        │
        ├─ listPages: true ──► içindekiler dönüyor:
        │                        [{ slug, title, level, parentSlug, hasDiagrams }, ...]
        │
        ├─ prepareOnly: true ─► arka planda indexer'ı başlatır,
        │                        { status: "ready" | "index_building" } döner
        │
        ▼  (varsayılan — sayfayı çek)
   cache.db hit?
        ├─ taze (≤ 24 saat)  ─►  hemen döndür
        ├─ süresi geçmiş     ─►  SHA probe: aynı commit mi?
        │                          ├─ evet ─► TTL'i yenile, cache'i döndür
        │                          └─ hayır ─► sayfayı yeniden çek
        └─ miss              ─►  Playwright → canonical tree → Markdown
        │
        ▼
   Markdown + diagram'lar + kod + citation footer (byte-equal, assert'li)
```

`get_page` **tek non-readonly tool**'dur. `prepareOnly: true` branch'i HTTP fetch + sqlite write yapar; CodeWiki'nin origin başına 4 saniyede 1 sayfa rate-limit'ine tabidir. v0.6'daki `request_indexing` tool'u v0.7'de bu branch'in içine alındı.

## 4. `find_chunks` — esas iş yükü (hybrid RAG)

Hybrid retrieval pipeline. Her chunk'la beraber beş skor döner: `vectorScore`, `bm25Score`, `rrfScore`, `rerankScore` artı iki pre-fusion rank. Agent (veya sen) "bu chunk neden döndü?" diye merak ettiğinde cevap tamamen incelenebilir.

**Off-project sorgu.** `repo` parametresini boş bırakırsan zaten indekslenmiş bütün repolarda arar. Henüz bağımlılığın olmayan bir repo'yu CodeWiki'ye sormak istersen 3 tool'u compose et:

```
   resolve_repo({ query: "react" })                              → { owner: "facebook", repo: "react" }
   get_page({ repo: "facebook/react", prepareOnly: true })       → { status: "ready" | "index_building" }
   find_chunks({ query: "rules of hooks", repo: "facebook/react" })
                                                                 → citation'lı ranked chunks
```

Reranker erişilemezken (download timeout, runtime error, circuit-breaker açık) sonuç yine döner — sadece vector benzerliğine göre sıralı ve `degraded: true` etiketli olarak.

## 5. `find_neighbors` — knowledge graph traversal

Beş kayıtlı edge tipi + query-zamanı türetilen `dep_link`:

```
   code_ref         sayfa  ──refers──►  source file
   diagram_edge     node   ──edge────►  node             (diagram içinde)
   diagram_member   node   ──in──────►  diagram cluster
   section_link     bölüm  ──anchor──►  bölüm            (aynı sayfa)
   cross_repo_ref   sayfa  ──cites───►  dış repo
   ──────────────────────────────────────────────────────────────────────
   dep_link         proje  ──uses────►  indexed repo     (query-zamanı türetilir)
```

İsteğe bağlı `query` parametresi verildiğinde komşular semantik benzerliğe göre yeniden sıralanır — mevcut embedder kullanılır, ayrı model yok. `CODEWIKI_DISABLE_KG=1` ile `find_neighbors` tamamen kayıttan düşer (rollback path).

## Status envelope'ları

Bazı tool'lar throw etmek yerine fail-soft döner. Sonuçtaki `status` alanı agent'a ne yapacağını söyler:

| Status | Anlamı |
|---|---|
| `ok` | Varsayılan başarı (genelde gösterilmez). |
| `no_docs` | Repo'da CodeWiki kapsamı yok. Sonuç alternatif URL'ler (GitHub, npm) içeren bir `fallbacks` array'i taşır. |
| `no_match` | `resolve_repo` registry metadata'sında GitHub URL bulamadı. |
| `rate_limited` | Upstream backoff. Sonuç `retryAfterSeconds` içerir. |
| `retry` | Geçici hata. Sonuç `retryAfterSeconds` içerir. |
| `index_building` | Indexer `INDEX_BUILD_TIMEOUT_MS`'i aştı. Boş sonuç; client kısa süre sonra retry etmeli. |
| `degraded` | Reranker fallback'e düştü; sonuçlar yine geldi (status enum'ı değil, sonuç üzerinde boolean alan). |

Sert hatalar (validation, programmer error, infrastructure failure) throw edilir — MCP SDK throw'u `isError: true`'ya çevirir.

## Gerçek senaryolar

### Senaryo 1 — Next.js cache muamması

> *"Bu component'te `revalidatePath` çağrım neden cache'lenmiş fetch'i yenilemiyor?"*

```
   Agent'ın muhakemesi (tool trace'lerinden görünür):
   ─────────────────────────────────────────────────────────────
   1. (session başında) list_project_dependencies bana söyledi:
      next → vercel/next.js, 18 sayfa indexli.

   2. find_chunks({
        query: "revalidatePath cached fetch server component",
        repos: ["vercel/next.js"]
      })
      ► top chunk: "On-demand revalidation" bölümü,
        rrfScore 0.84, rerankScore 9.2.

   3. get_page({
        owner: "vercel", repo: "next.js",
        slug: "app-router/caching",
        subsection: "on-demand-revalidation"
      })
      ► revalidatePath(path, type) imzasıyla tam Markdown.

   4. find_neighbors({ source: "node", id: "RouteCache" })
      ► RouteCache ─► FullRouteCache, DataCache, RouterCache,
                       RequestMemoization (hepsi citation'lı).
   ─────────────────────────────────────────────────────────────
   Cevap (özet):
     "revalidatePath(path) tek başına yalnız route segment cache'i
     invalidate eder. force-cache fetch'in Data Cache'te yaşar ve
     bağımsız key'lenir. İki cache'i de temizlemek için
     revalidatePath(path, 'page') kullan veya fetch'i tag'leyip
     revalidateTag(tag) çağır.  — kaynak commit a1b2c3d'ye pinli"
```

### Senaryo 2 — Tanımadığın bir kütüphaneye onboarding

> *"Projeye az önce `tanstack-query` ekledim. Beni gezdir."*

```
   Agent'ın tool akışı:
     resolve_repo("@tanstack/react-query")             → TanStack/query
     get_page({ owner, repo, prepareOnly: true })      → pre-warm
     get_page({ owner, repo, listPages: true })        → 14 sayfa
     find_chunks({ query: "core concepts",             → 5 chunk
                   repo: "TanStack/query", k: 5 })
     get_page({ owner, repo, slug: "guides/important-defaults" })

   Kullanıcının gördüğü:
     Citation ile yüklü, grounded bir tur — "query", "mutation",
     "staleTime vs gcTime", "queryClient invalidation" — az önce
     install'ladığı commit'e pinli olarak.
```

### Senaryo 3 — Knowledge graph ile mimari keşif

> *"Prisma client'ında data flow'u göster."*

```
   find_neighbors({ source: "page",
                    slug: "client/architecture",
                    kinds: ["diagram_edge", "diagram_member"] })
        │
        ▼
   QueryEngine ─► Request ─► Connector ─► Driver ─► Database
        │          │           │           │
        └──────────┴───────────┴───────────┴──► hepsinin yanında
                                                 belirli source file'lara
                                                 citation (code_ref edge)
```

Agent gerçek modül isimleriyle bir mimari özet derler — genel ORM gevezeliği değil, gerçek dosya isimleriyle.

### Senaryo 4 — Derin daldan önce pre-warm

> *"Bu öğleden sonra auth flow'u refactor edeceğim. `next-auth`, `lucia` ve `iron-session` doc'ları hazır olsun."*

```
   for repo in [nextauthjs/next-auth, lucia-auth/lucia, vvo/iron-session]:
       get_page({ owner, repo, prepareOnly: true })
   ─────────────────────────────────────────────────────────────
   ~12 saniye sonra üç index cache.db'de sıcak. Sonraki her
   find_chunks çağrısı <50 ms'de döner, cold start yok.
```

---

Sıradaki: [Yapılandırma](/tr/guide/yapilandirma) — environment variable'lar, sorun giderme ve operator knob'ları.
