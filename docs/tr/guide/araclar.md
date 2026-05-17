# 5 araç

Bu araçları siz çağırmazsınız — agent çağırır. Liste bilerek kısa tutulmuştur; her birinin ne yaptığını bilmek, agent'ın akıl yürütmesini okurken işinize yarar.

::: tip Sabit yüzey
Sunucu tam olarak **beş araç** kaydeder. `buildServer()` içindeki regex `search`, `ask`, `query`, `generate`, `index` veya `write` içeren her ismi reddeder — hiçbir eklenti veya kanca API'yi sessizce genişletemez. `get_page` tek yazma yetkili araçtır (`prepareOnly: true` dalı HTTP isteği yapar ve sqlite'a yazar).
:::

## 1. `list_project_dependencies` — temel

Oturum başında, otomatik olarak ve bir kez çağrılır. Agent ilk düşüncesinden önce eksiksiz bir kapsam raporunu eline alır.

```
   Oturum başı
        │
        ▼
   Manifest'i tara  ──►  Depoyu çöz  ──►  CodeWiki kapsamını kontrol et
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

Agent depo adresini zaten biliyorsa bu adım atlanır. Kullanıcı "react'in dokümanına bak" dediğinde çözücü `react` → `facebook/react` eşlemesini yapar.

```
   "react"  ─►  npm registry  ─►  repository.url  ─►  facebook/react
   "lodash" ─►  npm           ─►  github.com/...  ─►  lodash/lodash
   "rails"  ─►  RubyGems      ─►  source_code_uri ─►  rails/rails
```

Registry'de GitHub deposu URL'i yoksa `status: "no_match"` döner.

## 3. `get_page` — sayfa, alt bölüm, içindekiler ya da ön ısıtma

Tek araçtan üç ayrı kip:

```
   Girdi:  { owner, repo, slug?, subsection?, listPages?, prepareOnly? }
        │
        ├─ listPages: true ──► içindekiler döner:
        │                        [{ slug, title, level, parentSlug, hasDiagrams }, ...]
        │
        ├─ prepareOnly: true ─► arka planda indeksleyiciyi başlatır,
        │                        { status: "ready" | "index_building" } döner
        │
        ▼  (varsayılan — sayfayı getir)
   cache.db'de var mı?
        ├─ taze (≤ 24 saat)  ─►  hemen döndür
        ├─ süresi geçmiş     ─►  SHA kontrolü: commit aynı mı?
        │                          ├─ evet ─► TTL'i tazele, önbelleği döndür
        │                          └─ hayır ─► sayfayı baştan getir
        └─ yok               ─►  Playwright → canonical tree → Markdown
        │
        ▼
   Markdown + diyagramlar + kod + kaynak alt bilgisi (değişmez, testle doğrulanmış)
```

`get_page` **tek yazma yetkili araçtır**. `prepareOnly: true` dalı HTTP isteği yapar ve sqlite'a yazar; her kaynak için 4 saniyede 1 sayfa hız sınırına tabidir. v0.6'daki `request_indexing` aracı, v0.7'de bu dalın içine alındı.

## 4. `find_chunks` — esas iş yükü (hibrit RAG)

Hibrit arama akışı. Her parçayla beraber beş ayrı puan döner: `vectorScore`, `bm25Score`, `rrfScore`, `rerankScore` ve füzyon öncesi iki sıralama bilgisi. Agent (veya siz) "bu parça neden döndü?" diye sorduğunuzda cevap tamamen incelenebilir.

**Proje dışı sorgu.** `repo` parametresini boş bırakırsanız hâlihazırda indekslenmiş tüm depolarda arama yapılır. Henüz bağımlılığınız olmayan bir depoya CodeWiki üzerinden sormak isterseniz üç aracı birlikte kullanın:

```
   resolve_repo({ query: "react" })                              → { owner: "facebook", repo: "react" }
   get_page({ repo: "facebook/react", prepareOnly: true })       → { status: "ready" | "index_building" }
   find_chunks({ query: "rules of hooks", repo: "facebook/react" })
                                                                 → kaynak gösterimli sıralı parçalar
```

Yeniden sıralayıcıya ulaşılamadığında (indirme zaman aşımı, çalışma zamanı hatası, devre kesici açık) sonuç yine döner — sadece vektör benzerliğine göre sıralı ve `degraded: true` etiketiyle.

## 5. `find_neighbors` — bilgi grafı gezinti

Beş kayıtlı bağlantı türü + sorgu zamanında türetilen `dep_link`:

```
   code_ref         sayfa  ──refers──►  kaynak dosya
   diagram_edge     düğüm  ──edge────►  düğüm            (diyagram içinde)
   diagram_member   düğüm  ──in──────►  diyagram kümesi
   section_link     bölüm  ──anchor──►  bölüm            (aynı sayfa)
   cross_repo_ref   sayfa  ──cites───►  dış depo
   ──────────────────────────────────────────────────────────────────────
   dep_link         proje  ──uses────►  indekslenmiş depo     (sorgu zamanı)
```

İsteğe bağlı `query` parametresi verildiğinde komşular semantik benzerliğe göre yeniden sıralanır — mevcut embedder kullanılır, ayrı bir model gerekmez. `CODEWIKI_DISABLE_KG=1` verilirse `find_neighbors` tamamen kayıttan düşer (geri dönüş yolu).

## Durum zarfları

Bazı araçlar hata fırlatmak yerine yumuşak başarısızlıkla döner. Sonuçtaki `status` alanı agent'a ne yapacağını söyler:

| Status | Anlamı |
|---|---|
| `ok` | Varsayılan başarı (genelde gösterilmez). |
| `no_docs` | Depoda CodeWiki kapsamı yok. Sonuç, alternatif URL'ler (GitHub, npm) içeren bir `fallbacks` dizisi taşır. |
| `no_match` | `resolve_repo`, registry metadata'sında GitHub URL'i bulamadı. |
| `rate_limited` | Üst kaynaktan hız sınırı. Sonuç `retryAfterSeconds` içerir. |
| `retry` | Geçici hata. Sonuç `retryAfterSeconds` içerir. |
| `index_building` | İndeksleyici `INDEX_BUILD_TIMEOUT_MS` süresini aştı. Boş sonuç; istemci kısa süre sonra tekrar denemeli. |
| `degraded` | Yeniden sıralayıcı yedek yola düştü; sonuçlar yine geldi (durum enum'ı değil, sonucun üzerinde boolean bir alandır). |

Sert hatalar (doğrulama hatası, programcı hatası, altyapı hatası) `throw` ile fırlatılır — MCP SDK bunu `isError: true` cevabına çevirir.

## Gerçek senaryolar

### Senaryo 1 — Next.js cache bilmecesi

> *"Bu component'te `revalidatePath` çağrım neden cache'lenmiş fetch'i tazelemiyor?"*

```
   Agent'ın akıl yürütmesi (araç akışından görünür):
   ─────────────────────────────────────────────────────────────
   1. (oturum başında) list_project_dependencies şunu söyledi:
      next → vercel/next.js, 18 sayfa indekslendi.

   2. find_chunks({
        query: "revalidatePath cached fetch server component",
        repos: ["vercel/next.js"]
      })
      ► en alakalı parça: "On-demand revalidation" bölümü,
        rrfScore 0.84, rerankScore 9.2.

   3. get_page({
        owner: "vercel", repo: "next.js",
        slug: "app-router/caching",
        subsection: "on-demand-revalidation"
      })
      ► revalidatePath(path, type) imzasıyla tam Markdown.

   4. find_neighbors({ source: "node", id: "RouteCache" })
      ► RouteCache ─► FullRouteCache, DataCache, RouterCache,
                       RequestMemoization (hepsi kaynak gösterimli).
   ─────────────────────────────────────────────────────────────
   Cevap (özet):
     "revalidatePath(path) tek başına yalnızca route segment cache'ini
     geçersiz kılar. force-cache fetch'iniz Data Cache içinde durur ve
     ayrı bir anahtarla saklanır. İki cache'i de temizlemek için
     revalidatePath(path, 'page') kullanın ya da fetch'inizi tag'leyip
     revalidateTag(tag) çağırın.  — kaynak: commit a1b2c3d"
```

### Senaryo 2 — Tanımadığınız bir kütüphaneye onboarding

> *"Projeye az önce `tanstack-query` ekledim. Beni biraz gezdir."*

```
   Agent'ın araç akışı:
     resolve_repo("@tanstack/react-query")             → TanStack/query
     get_page({ owner, repo, prepareOnly: true })      → ön ısıt
     get_page({ owner, repo, listPages: true })        → 14 sayfa
     find_chunks({ query: "core concepts",             → 5 parça
                   repo: "TanStack/query", k: 5 })
     get_page({ owner, repo, slug: "guides/important-defaults" })

   Kullanıcının gördüğü:
     Kaynak gösterimli, gerçek dosyalara dayanan bir tur — "query",
     "mutation", "staleTime vs gcTime", "queryClient invalidation"
     — tam da az önce kurduğunuz commit'e sabitlenerek.
```

### Senaryo 3 — Bilgi grafıyla mimari keşif

> *"Prisma client'ında veri akışını göster."*

```
   find_neighbors({ source: "page",
                    slug: "client/architecture",
                    kinds: ["diagram_edge", "diagram_member"] })
        │
        ▼
   QueryEngine ─► Request ─► Connector ─► Driver ─► Database
        │          │           │           │
        └──────────┴───────────┴───────────┴──► her birinin yanında
                                                 belirli kaynak dosyalara
                                                 kaynak gösterimi (code_ref)
```

Agent gerçek modül isimleriyle bir mimari özet derler — genel ORM gevezeliği değil, somut dosya isimleriyle.

### Senaryo 4 — Derin daldan önce ön ısıtma

> *"Bu öğleden sonra auth flow'unu yeniden yazacağım. `next-auth`, `lucia` ve `iron-session` dokümanları hazır olsun."*

```
   for repo in [nextauthjs/next-auth, lucia-auth/lucia, vvo/iron-session]:
       get_page({ owner, repo, prepareOnly: true })
   ─────────────────────────────────────────────────────────────
   Yaklaşık 12 saniye sonra üç indeks cache.db içinde sıcak. Sonraki
   her find_chunks çağrısı 50 ms'in altında döner; soğuk başlangıç yok.
```

---

Sıradaki: [Yapılandırma](/tr/guide/yapilandirma) — ortam değişkenleri, sorun giderme ve operatör ayarları.
