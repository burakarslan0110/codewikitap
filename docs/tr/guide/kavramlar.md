# CodeWikiTap nedir?

## Google CodeWiki — upstream kaynak

[**Google CodeWiki**](https://codewiki.google), Google'ın bir araştırma projesi: gezegendeki her public GitHub deposu için derinlikli, yapılandırılmış bir teknik wiki üretiyor. Arka planda tamamen Gemini çalışıyor — her sayfa kaynak ağacından sentezleniyor, her pull-request birleşmesinde yeniden üretiliyor ve belirli bir commit SHA'sına sabitleniyor; yani dokümantasyon koddan asla "kaymıyor".

CodeWiki sayfasında bulduğun şey, sıradan bir API tablosundan ibaret değil:

- **Modül seviyesinde anlatım** — sana onboarding yapan kıdemli bir mühendis gibi: modül ne işe yarar, sistemde nasıl konumlanır, nelere bağlıdır.
- **Mimari diyagramlar** (Mermaid) — büyük sistemler için, gerçek call-graph'tan otomatik üretilmiş.
- **Cross-reference'lar** — kaynak dosyalar, type'lar ve diğer depolar arasında.
- **Citation footer** — her sayfanın altında, açıklamanın türetildiği commit ve dosyaya doğrudan link.

Dikkat edilecek iki şey var:

1. **Yalnız public GitHub.** Private repo erişimi waitlist'teki bir Gemini extension'ının arkasında; CodeWikiTap bu kısıtı aşmıyor.
2. **AI-generated içerik.** Gemini iyi ama yanılmaz değil. Her sayfa kaynağına link veriyor — doğruluk kritikse oraya bakmak lazım.

::: warning Google ile bağlantılı değil
CodeWikiTap bağımsız bir open-source projedir. "CodeWiki" adı yalnızca upstream veri kaynağı olarak betimleyici şekilde geçer. İçerikte ne Google'a ait bir parça vardır ne de Google'ın onayı/desteği söz konusudur.
:::

## CodeWikiTap — lokal MCP server

CodeWikiTap, makinende lokal çalışan küçük bir Node/TypeScript programı — bir **Model Context Protocol (MCP) server**. Kodlama agent'ın (Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, Windsurf) ona stdio üzerinden konuşur. Kilitli bir **beş tool**'luk yüzey sunar ve agent ihtiyacı olduğu anda CodeWiki içeriğini context'ine çekebilir.

En kısa zihinsel model:

```
       ┌────────────────────────┐
       │   Kodlama agent'ın     │
       │   bir soru sorar       │
       └────────────┬───────────┘
                    │  stdio (JSON-RPC)
                    ▼
       ┌────────────────────────┐
       │      CodeWikiTap       │   ← lokal, API key yok, telemetri yok
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

- **Project-awareness.** Açılışta manifest'ini (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …) tarar, direct dependency'lerini GitHub repolarına çözer, her birinde CodeWiki kapsamı olup olmadığını yoklar. Agent, daha ilk soruyu sormadan hangi kütüphanenin dokümantasyonu olduğunu bilir.
- **Hybrid retrieval.** BM25 keyword search + dense vector search → Reciprocal Rank Fusion → cross-encoder rerank. Her chunk'a beş ayrı puan döndürülür; sıralama denetlenebilir, kara kutu değil.
- **Knowledge graph.** Indexing sırasında aynı SQLite transaction'ında beş tipte edge çıkarılır. Agent "`src/auth.ts`'e hangi sayfalar atıf yapıyor?" veya "`AuthRouter` diagram node'una neler bağlı?" diye sorabilir.
- **Citation zorunlu.** Her chunk ve her sayfa cevabı, source URL ile commit SHA'yı taşıyan byte-equal bir footer ile gelir. Footer test'lerle assert edilir; susturmanın yolu yok.
- **Kilitli tool yüzeyi.** Server altıncı bir tool kaydetmeyi reddeder. `/(search|ask|query|generate|index|write)/i` ile eşleşen isimler kod seviyesinde reddedilir — hiçbir plugin veya hook API'yi sessizce genişletemez.

## Neden RAG-powered? Doc'u doğrudan vermek varken neden?

Bir CodeWiki sayfası tipik olarak 2.000 – 4.000 token civarındadır. Gerçek bir kütüphanenin onlarcası vardır. Örneğin Next.js bu yazı yazılırken **18 sayfa**; React'in onlarcası var. Hepsini agent'ın context'ine doldurmaya kalkarsan, daha soruyu okumadan token bütçen biter.

```
NAİF YAKLAŞIM (RAG yok) — "agent'a her şeyi ver"

   ┌─────────────────────────────────────────────────────────┐
   │ vercel/next.js  CodeWiki = 18 sayfa × ~3.000 tok ≈ 54k  │
   │ facebook/react  CodeWiki = 40+ sayfa × ~3.000 tok ≈ 120k│
   │ prisma/prisma   CodeWiki = 25+ sayfa × ~3.000 tok ≈ 75k │
   │                              ...                        │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼  prompt'a tıkıştırıldı
              ✗ context patladı · ✗ cost fırladı · ✗ relevance gürültüde kayboldu


RAG (CodeWikiTap'in yaptığı)

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

### Neden hybrid (BM25 + vector), tek değil?

- BM25 tek başına paraphrase'leri kaçırır — "data fetching" sorgusu "remote data loading" başlığını yakalamaz.
- Vector tek başına tam-eşleşmesi gereken sembolleri kaçırır — `useEffect` veya `revalidateTag` için keyword kesinliği şart.
- Reciprocal Rank Fusion (RRF, k=60) ile birleştirildiğinde her iki yöntemin kör noktası baskın olmaz. Cross-encoder rerank sonradan top adaylar üzerinde tam-attention çalıştırıp her iki yöntemden artakalan sıralama hatalarını da düzeltir.

Sonuçta agent'a giden context yükü naif enjeksiyona göre kabaca **40–80× daha küçük**, ölçülebilir biçimde daha yüksek recall ile (regression-locked floor'lar için: `tests/eval/` → `NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80`).

## Ne *değildir*

- **Bir AI modeli değildir.** İçinde bundle'lı model yok. CodeWikiTap, agent'ın zaten kullandığı AI'a giden **context kalitesini** iyileştirir.
- **Dokümantasyon üreticisi değildir.** İçerik burada üretilmez. Google CodeWiki'nin Gemini ile ürettiği dokümantasyon fetch'lenir.
- **Cloud servisi değildir.** Hiçbir şey makinenden çıkmaz. Lokal SQLite cache, lokal ONNX inference, sıfır telemetri.
- **Google ile bağlantılı değildir.** Bağımsız open-source proje; "CodeWiki" adı yalnızca upstream veri kaynağı olarak betimleyici şekilde geçer.
- **Private repo için değildir.** Google CodeWiki şu an yalnız public GitHub repolarını kapsar; private erişim waitlist'teki bir Gemini CLI extension'ının arkasında.

---

Sıradaki: [Kurulum](/tr/guide/kurulum) — CodeWikiTap'i agent'ına nasıl bağlarsın.
