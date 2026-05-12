<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap/main/assets/logo.png" alt="CodeWiKiTap" width="520"/>
</p>

<h1 align="center">CodeWiKiTap</h1>

<p align="center">
  <strong>Google CodeWiki dokümantasyonunu kodlama agent'ına RAG ile akıtan <em>unofficial</em> bir MCP server'ı — parçalanmış, kaynak gösterilmiş, paketin pinli olduğu commit SHA'sına sabitlenmiş şekilde.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codewikitap"><img src="https://img.shields.io/npm/v/codewikitap?color=1D4ED8&label=npm" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1D4ED8.svg" alt="MIT"/></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/node-20.x-339933?logo=node.js&logoColor=white" alt="Node"/></a>
  <a href="https://github.com/burakarslan0110/codewikitap/actions"><img src="https://github.com/burakarslan0110/codewikitap/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/status-unofficial-orange" alt="Unofficial"/>
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a> · 🇹🇷 <strong>Türkçe</strong>
</p>

```bash
npx codewikitap
```

---

## İçindekiler

1. [Google CodeWiki nedir?](#google-codewiki-nedir)
2. [CodeWiKiTap nedir?](#codewikitap-nedir)
3. [Neden RAG-powered? Doc'u doğrudan vermek varken neden?](#neden-rag-powered)
4. [Kaputun altında neler dönüyor?](#kaputun-altinda)
5. [Yedi tool](#yedi-tool)
6. [Gerçek senaryolar](#gercek-senaryolar)
7. [Hangi agent için nasıl kurulur](#kurulum)
8. [Desteklenen proje türleri](#desteklenen-projeler)
9. [Yapılandırma](#yapilandirma)
10. [Bilinmesi gerekenler](#bilinmesi-gerekenler)
11. [Ne değildir](#ne-degildir)
12. [Yol haritası, katkı, lisans](#yol-haritasi)

---

<a id="google-codewiki-nedir"></a>
## Google CodeWiki nedir?

[**Google CodeWiki**](https://codewiki.google), Google'ın bir araştırma projesi: gezegendeki her public GitHub deposu için derinlikli, yapılandırılmış bir teknik wiki üretiyor. Arka planda tamamen Gemini çalışıyor — her sayfa kaynak ağacından sentezleniyor, her pull-request birleşmesinde yeniden üretiliyor ve belirli bir commit SHA'sına sabitleniyor; yani dokümantasyon koddan asla "kaymıyor".

CodeWiki sayfasında bulduğun şey, sıradan bir API tablosundan ibaret değil:

- **Modül seviyesinde anlatım** — sana onboarding yapan kıdemli bir mühendis gibi: modül ne işe yarar, sistemde nasıl konumlanır, nelere bağlıdır.
- **Mimari diyagramlar** (Mermaid) — büyük sistemler için, gerçek call-graph'tan otomatik üretilmiş.
- **Cross-reference'lar** — kaynak dosyalar, type'lar ve diğer depolar arasında.
- **Citation footer** — her sayfanın altında, açıklamanın türetildiği commit ve dosyaya doğrudan link.

Dikkat edilecek iki şey var:

1. **Yalnız public GitHub.** Private repo erişimi waitlist'teki bir Gemini extension'ının arkasında; CodeWiKiTap bu kısıtı aşmıyor.
2. **AI-generated içerik.** Gemini iyi ama yanılmaz değil. Her sayfa kaynağına link veriyor — doğruluk kritikse oraya bakmak lazım.

> ⚠️ **CodeWiKiTap Google ile bağlantılı değildir.** CodeWiki adı yalnızca veri kaynağı olarak betimleyici şekilde geçer. Bu, bağımsız bir open-source projedir; içerikte ne Google'a ait bir parça vardır ne de Google'ın onayı/desteği söz konusudur.

---

<a id="codewikitap-nedir"></a>
## CodeWiKiTap nedir?

CodeWiKiTap, makinende lokal çalışan küçük bir Node/TypeScript programı — bir **Model Context Protocol (MCP) server**. Kodlama agent'ın (Claude Code, Cursor, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, …) ona stdio üzerinden konuşur. Kilitli bir **yedi tool**'luk yüzey sunar — altı read-only, bir pre-warm — ve agent ihtiyacı olduğu anda CodeWiki içeriğini context'ine çekebilir.

En kısa zihinsel model:

```
       ┌────────────────────────┐
       │   Kodlama agent'ın     │
       │   bir soru sorar       │
       └────────────┬───────────┘
                    │  stdio (JSON-RPC)
                    ▼
       ┌────────────────────────┐
       │      CodeWiKiTap       │   ← lokal, API key yok, telemetri yok
       │   (bu MCP server)      │
       └────────────┬───────────┘
                    │  hybrid retrieval, indekslenmiş CodeWiki sayfaları
                    ▼
       ┌────────────────────────┐
       │   Google CodeWiki      │   ← upstream, yalnız public repo
       │   (cache'li, SHA-pinli)│
       └────────────────────────┘
```

"Sadece CodeWiki'yi fetch'le" demek değil — üstüne şunları ekliyor:

- **Project-awareness.** Açılışta manifest'ini (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …) tarar, *direct* dependency'lerini GitHub repolarına çözer, her birinde CodeWiki kapsamı olup olmadığını yoklar. Agent, daha ilk soruyu sormadan hangi kütüphanenin dokümantasyonu olduğunu bilir.
- **Hybrid retrieval.** BM25 keyword search + dense vector search → Reciprocal Rank Fusion → cross-encoder rerank. Her chunk'a beş ayrı puan döndürülür; sıralama denetlenebilir, kara kutu değil.
- **Knowledge graph.** Indexing sırasında aynı SQLite transaction'ında beş tipte edge çıkarılır. Agent "`src/auth.ts`'e hangi sayfalar atıf yapıyor?" veya "`AuthRouter` diagram node'una neler bağlı?" diye sorabilir.
- **Citation zorunlu.** Her chunk ve her sayfa cevabı, source URL ile commit SHA'yı taşıyan byte-equal bir footer ile gelir. Footer test'lerle assert edilir; susturmanın yolu yok.
- **Kilitli tool yüzeyi.** Server sekizinci bir tool kaydetmeyi reddeder. `/(search|ask|query|generate|index|write)/i` ile eşleşen isimler kod seviyesinde reddedilir — hiçbir plugin veya hook API'yi sessizce genişletemez.

---

<a id="neden-rag-powered"></a>
## Neden RAG-powered? Doc'u doğrudan vermek varken neden?

Bir CodeWiki sayfası tipik olarak 2.000 – 4.000 token civarındadır. Gerçek bir kütüphanenin onlarcası vardır. Örneğin Next.js bu yazı yazılırken **18 sayfa**; React'in onlarcası var. Hepsini agent'ın context'ine doldurmaya kalkarsan, daha soruyu okumadan token bütçen biter.

```
NAİF YAKLAŞIM (RAG yok) — "agent'a her şeyi ver"

   ┌─────────────────────────────────────────────────────────┐
   │ vercel/next.js CodeWiki = 18 sayfa × ~3.000 tok ≈ 54k   │
   │ facebook/react CodeWiki = 40+ sayfa × ~3.000 tok ≈ 120k │
   │ prisma/prisma CodeWiki  = 25+ sayfa × ~3.000 tok ≈ 75k  │
   │                              ...                         │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼  prompt'a tıkıştırıldı
              ✗ context patladı · ✗ cost fırladı · ✗ relevance gürültüde kayboldu


RAG (CodeWiKiTap'in yaptığı)

   54k token Next.js doc'u
          │
          ▼  heading sınırlarında chunk'landı (canonical tree)
   ~200 chunk × ~250 token
          │
          ▼  cache.db'ye bir kez indekslendi
   BM25 (FTS5) ┐
               ├──► RRF fusion ──► cross-encoder rerank
   dense vec  ─┘                              │
                                              ▼
                          top-K chunk (~5 × ~250 tok ≈ 1,2k tok)
                                              │
                                              ▼
                          agent'a citation ile teslim edildi
              ✓ odaklı · ✓ ucuz · ✓ denetlenebilir · ✓ doğrulanabilir
```

**Neden hybrid (BM25 + vector), tek değil?**

- BM25 tek başına paraphrase'leri kaçırır — "data fetching" sorgusu "remote data loading" başlığını yakalamaz.
- Vector tek başına tam-eşleşmesi gereken sembolleri kaçırır — "`useEffect`" veya "`revalidateTag`" için keyword kesinliği şart.
- Reciprocal Rank Fusion (RRF, k=60) ile birleştirildiğinde her iki yöntemin kör noktası baskın olmaz. Cross-encoder rerank sonradan top adaylar üzerinde tam-attention çalıştırıp her iki yöntemden artakalan sıralama hatalarını da düzeltir.

Sonuçta agent'a giden context yükü naif enjeksiyona göre kabaca **40–80×** daha küçük, ölçülebilir biçimde daha yüksek recall ile (regression-locked floor'lar için: `tests/eval/baseline-v2.7-hybrid.json` → `NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80`).

---

<a id="kaputun-altinda"></a>
## Kaputun altında neler dönüyor?

Üç şey, çoğu arka planda:

### 1. Boot — bu proje neye bağımlı, bul

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
   Her repo için CodeWiki kapsamı yokla  (cache 24h, SHA-anchored)
          │
          ▼
   chokidar watcher: manifest + workspace member + aux file'lara abone
   (sonradan gelen `pnpm add foo` server'ı restart'lamadan yakalanır)
```

### 2. Index — sayfaları aranabilir chunk'lara çevir (lazy)

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
   │  INSERT fts_chunks    (FTS5 virtual table, v2.7)              │
   │  INSERT kg_edges      (code_ref · diagram_edge · diagram_     │
   │                        member · section_link · cross_repo_ref)│
   │  UPDATE wiki_index_status                                     │
   └───────────────────────────────────────────────────────────────┘
          │
          ▼
   `request_indexing`, agent'a bir repo'yu önceden indeksleme imkânı verir;
   böylece ilk gerçek sorgu indexer'ın 5 saniyelik deadline'ı ile yarışmaz.
```

### 3. Query — soruya cevap üret

```
   Agent → find_chunks({ query: "...", repos: [...] })
          │
          ▼
   Indexer.indexRepo() vs 5 sn deadline yarışı
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

Index 5 saniyede hazır değilse çağrı anında `status: 'index_building'` döner ve build arka planda sürer — bir sonraki çağrı warm index'e gelir.

---

<a id="yedi-tool"></a>
## Yedi tool

Bunları sen çağırmazsın — agent çağırır. Liste bilerek kısa tutulmuş; her birinin ne yaptığını bilmek agent'ın muhakemesini okurken işe yarar.

### 1. `list_project_dependencies` — temel

Session başında, otomatik, bir kez çağrılır. Agent ilk düşüncesinden önce tam kapsam raporunu alır.

```
   Session başı
        │
        ▼
   Manifest tara  ──►  Repo çöz  ──►  CodeWiki kapsamı yokla
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

### 2. `resolve_repo` — ad → `owner/repo`

Agent slug'ı zaten biliyorsa atlanır. Kullanıcı "react'in dokümanına bak" dediğinde resolver `react` → `facebook/react` map'ini yapar.

```
   "react"  ─►  npm registry  ─►  repository.url  ─►  facebook/react
   "lodash" ─►  npm           ─►  github.com/...  ─►  lodash/lodash
   "rails"  ─►  RubyGems      ─►  source_code_uri ─►  rails/rails
```

### 3. `list_pages` — içindekiler

```
   Input:  { owner, repo }
   Output: [
     { slug: "getting-started",     title: "Getting Started",   depth: 0 },
     { slug: "app-router",          title: "App Router",        depth: 0,
       subsections: [
         "data-fetching",
         "caching/route-cache",
         "caching/data-cache",
         "caching/on-demand-revalidation",
         ...
       ]
     },
     ...
   ]
```

### 4. `get_page` — bir sayfayı (veya sub-section'ı) Markdown olarak getir

```
   Input:  { owner, repo, slug, subsection? }
        │
        ▼
   cache.db hit?
        ├─ taze (≤ 24h)      ─►  hemen döndür
        ├─ süresi geçmiş     ─►  SHA probe: aynı commit mi?
        │                          ├─ evet ─► TTL'i yenile, cache'i döndür
        │                          └─ hayır ─► sayfayı yeniden çek
        └─ miss              ─►  Playwright → canonical tree → Markdown
        │
        ▼
   Markdown + diagram'lar + kod + citation footer (byte-equal, assert'li)
```

### 5. `find_chunks` — esas iş yükü (hybrid RAG)

Yukarıdaki diyagrama bak. Bilmen gereken şey: her chunk ile beraber **beş puan** dönüyor — `vectorScore`, `bm25Score`, `rrfScore`, `rerankScore` + iki pre-fusion rank. Agent (veya sen) "bu chunk neden döndü?" diye merak ettiğinde cevap tamamen incelenebilir.

### 6. `find_neighbors` — knowledge graph traversal

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

İsteğe bağlı `query` parametresi verildiğinde komşular semantik benzerliğe göre yeniden sıralanır — mevcut embedder kullanılır, ayrı model yok.

### 7. `request_indexing` — pre-warm (tek non-readonly tool)

Nazikçe "lütfen bu repo'nun indeksini şimdi kur ki sonraki çağrım cold-start ödemesin" demek. Agent kullanıcı sormadan bir kütüphaneyi keşfetmeye karar verdiğinde işe yarar.

```
   request_indexing({ owner, repo })
        │
        ▼
   Arka planda Indexer.indexRepo() başlat, anında dön
        │
        ▼
   O repo için bir sonraki find_chunks → warm index, yarış yok, anında
```

---

<a id="gercek-senaryolar"></a>
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
      ► top chunk: "On-demand revalidation" bölümü, rrfScore 0.84,
        rerankScore 9.2.

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
     resolve_repo("@tanstack/react-query")       → TanStack/query
     request_indexing({ owner, repo })           → pre-warm
     list_pages({ owner, repo })                 → 14 sayfa
     find_chunks({ query: "core concepts",       → 5 chunk
                   repos: ["TanStack/query"], k: 5 })
     get_page({ slug: "guides/important-defaults" })

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
       request_indexing({ owner, repo })
   ─────────────────────────────────────────────────────────────
   ~12 saniye sonra üç index cache.db'de sıcak. Sonraki her
   find_chunks çağrısı <50 ms'de döner, cold start yok.
```

---

<a id="kurulum"></a>
## Hangi agent için nasıl kurulur

İlk çalıştırmada Playwright'ın `chromium-headless-shell`'i (~30 MB) indirilir — CodeWiki Angular SPA olduğu için düz HTTP isteği boş bir shell döndürür, gerçek browser şart. İlk `find_chunks` çağrısında ONNX embedder + reranker modelleri (toplam ~50 MB) iner. İkisi de tek seferlik, kalıcı cache'lenir.

`codewikitap`'i doğrudan çalıştırmazsın — agent onu bir child process olarak başlatır. Aşağıdaki dört satırlık config bloğunu agent'ına ekle.

### Claude Code

`~/.claude/mcp.json` (user level) veya proje kökünde `.mcp.json`:

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

Veya Claude plugin marketplace üzerinden:

```text
/plugin marketplace add burakarslan0110/codewikitap
/plugin install codewikitap@burakarslan0110-codewikitap
```

### Cursor

`~/.cursor/mcp.json` veya `<proje>/.cursor/mcp.json` — Claude Code ile aynı JSON şekli.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.codewikitap]
command = "npx"
args = ["-y", "codewikitap"]
```

### Gemini CLI

`~/.gemini/settings.json` içinde `mcpServers` altına — Claude Code şekliyle birebir aynı.

### Qwen Code, opencode, Antigravity

Hepsi `mcpServers` (veya `mcp`) JSON nesnesi alır — Cursor / Claude Code şekliyle aynı. Yapıştır, restart'la, hazır.

---

<a id="desteklenen-projeler"></a>
## Desteklenen proje türleri

CodeWiKiTap projeni "tanımak" için manifest'i okur. 11 ecosystem'de tam destek var, gerektiğinde workspace traversal ile:

| Ecosystem | Manifest | Workspace / ek |
|---|---|---|
| **JavaScript / TypeScript** | `package.json` | npm/pnpm/yarn `workspaces`, `pnpm-workspace.yaml` |
| **Python** | `requirements.txt`, `pyproject.toml` | PEP 621 + Poetry |
| **Go** | `go.mod`, `go.work` | tam workspace farkındalığı |
| **Rust** | `Cargo.toml` | `[workspace] members` (literal + glob) |
| **PHP** | `composer.json` | platform paketleri otomatik filtrelenir |
| **Java (Maven)** | `pom.xml` | tam property resolution + cycle-safe recursive BOM imports + `<parent>` POM + `<modules>` aggregator traversal |
| **Java (Gradle)** | `gradle/libs.versions.toml` | `settings.gradle(.kts)` subproject discovery + her subproject için `build.gradle(.kts)` parsing |
| **Ruby** | `Gemfile.lock` (tercih edilen) | `Gemfile` regex fallback |
| **.NET** | `*.csproj` + `Directory.Packages.props` | CPM + `*.sln` çözümlü discovery |

Chat'te "react" demen yeterli — resolver onu `facebook/react`'a map'ler. Maven Central, RubyGems, NuGet, crates.io, Packagist ve npm registry hepsi entegre.

---

<a id="yapilandirma"></a>
## Yapılandırma

Çoğu durumda varsayılanlar yeter. Gerçekten dokunmak isteyebileceğin değişkenler:

| Değişken | Varsayılan | İşlev |
|---|---|---|
| `LOG_LEVEL` | `info` | Stderr log seviyesi (`debug` / `info` / `warn` / `error`). |
| `CODEWIKI_INCLUDE_DEV_DEPS` | kapalı | `devDependencies` de taransın (test tool dokümantasyonu gerektiğinde). |
| `CODEWIKI_DISABLE_WATCH` | kapalı | Manifest değişikliği izlenmesin (CI/CD). |
| `CODEWIKI_DISABLE_KG` | kapalı | Knowledge graph kurulmasın; `find_neighbors` kaydedilmesin. |
| `CODEWIKI_DISABLE_PREWARM` | kapalı | Açılışta otomatik prewarm atlansın. |
| `CODEWIKI_FORCE_NO_BM25` | kapalı | Vector-only modu (BM25 dalı atlanır). |
| `CODEWIKI_RERANK_TOP_N` | `50` | Reranker'a verilen aday sayısı. |

Tam liste: [CONTRIBUTING.md](CONTRIBUTING.md).

---

<a id="bilinmesi-gerekenler"></a>
## Bilinmesi gerekenler

- **AI-generated içerik.** Google CodeWiki sayfaları Gemini tarafından üretilir, hata içerebilir. Her chunk ve sayfa altındaki byte-equal citation footer doğrulama için var.
- **Rate limit.** CodeWiki, aktif bot detection'lı bir Angular SPA. CodeWiKiTap kendi tarafında **origin başına 4 saniyede 1 sayfa yükleme** limiti uygular. Tipik interaktif kullanımda hissedilmez; çok sayıda repo'yu eşzamanlı bulk-indeksleme yaparken hissedilir.
- **Install boyutu.** İlk çalıştırma: ~30 MB Playwright shell. İlk `find_chunks`: ~50 MB ONNX model. İkisi de tek seferlik, kalıcı olarak `~/.cache/...` altında.
- **Kapsam.** Yalnız direct dependency'ler. `peerDependencies` ve transitive dep'ler kapsam dışı; npm `optionalDependencies` dahil.
- **Offline dostu.** Bir repo'nun chunk ve KG edge'leri `cache.db`'ye girdikten sonra, 24 saatlik SHA probe devreye girene kadar sorgular network round-trip'i olmadan çalışır.

---

<a id="ne-degildir"></a>
## Ne *değildir*

- **Bir AI modeli değildir.** İçinde bundle'lı model yok. CodeWiKiTap, agent'ın zaten kullandığı AI'a giden **context kalitesini** iyileştirir.
- **Dokümantasyon üreticisi değildir.** İçerik burada üretilmez. Google CodeWiki'nin Gemini ile ürettiği dokümantasyon fetch'lenir.
- **Cloud servisi değildir.** Hiçbir şey makinenden çıkmaz. Lokal SQLite cache, lokal ONNX inference, sıfır telemetri.
- **Google ile bağlantılı değildir.** Bağımsız open-source proje; "CodeWiki" adı yalnızca upstream veri kaynağı olarak betimleyici şekilde geçer.
- **Private repo için değildir.** Google CodeWiki şu an yalnız public GitHub repolarını kapsar; private erişim waitlist'teki bir Gemini CLI extension'ının arkasında.

---

<a id="yol-haritasi"></a>
## Yol haritası

- **v0.3** *(şu anki)* — İlk public npm sürümü. İki dilli doc, plugin marketplace, CI/CD, marka kimliği.
- **v0.4** — `--version` / `--help` argv handler'ları; daha geniş smoke-test kapsamı; macOS CI matrisi.
- **v0.5+** — Hosted remote MCP transport (Cloudflare Workers + Browser Rendering) — lokal kurulum istemeyenler için.

---

## Katkı

[CONTRIBUTING.md](CONTRIBUTING.md) → pnpm toolchain, test akışı, release süreci. Güvenlik açıkları: [SECURITY.md](SECURITY.md), public issue olarak açma.

---

## Lisans

[MIT](LICENSE) — © 2026 Burak Arslan.

> CodeWiKiTap bağımsız, **unofficial** bir projedir. Google ile bağlantılı değildir; Google tarafından onaylanmamış veya desteklenmemiştir. "CodeWiki" adı yalnızca upstream veri kaynağı olarak betimleyici şekilde geçer.
