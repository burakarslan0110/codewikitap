# CodeWikiTap nedir?

## Google CodeWiki — kaynak

[**Google CodeWiki**](https://codewiki.google), Google'ın bir araştırma projesi: dünyadaki her herkese açık GitHub deposu için derinlikli ve yapılandırılmış bir teknik wiki üretiyor. Tüm üretimi Gemini yapıyor — her sayfa kaynak ağacından sentezleniyor, her pull request birleşmesinde yeniden oluşturuluyor ve belirli bir commit'e sabitleniyor; dolayısıyla dokümantasyon koddan asla "kaymıyor".

Bir CodeWiki sayfasında karşınıza çıkan şey sıradan bir API tablosu değildir:

- **Modül seviyesinde anlatım** — size onboarding yapan kıdemli bir mühendis edasıyla: modül ne işe yarar, sistemde nereye oturur, neye bağlıdır.
- **Mimari diyagramlar** (Mermaid) — büyük sistemler için, gerçek call-graph'tan otomatik üretilmiş.
- **Çapraz referanslar** — kaynak dosyalar, türler ve diğer depolar arasında.
- **Kaynak alt bilgisi** — her sayfanın altında, içeriğin türetildiği commit ve dosyaya doğrudan bağlantı.

İki nokta üzerinde durmak gerekiyor:

1. **Yalnızca herkese açık GitHub depoları.** Özel depo erişimi, bekleme listesindeki bir Gemini eklentisinin arkasında; CodeWikiTap bu kısıtı aşmıyor.
2. **Yapay zeka tarafından üretilen içerik.** Gemini iyi, ama yanılmaz değil. Her sayfa kaynağına bağlantı veriyor — doğruluk kritikse oradan teyit etmek gerekir.

::: warning Google ile bağlantısı yoktur
CodeWikiTap bağımsız bir açık kaynak projedir. "CodeWiki" adı yalnızca veri kaynağını belirtmek için kullanılır. İçerikte ne Google'a ait bir parça vardır ne de Google'ın onayı söz konusudur.
:::

## CodeWikiTap — yerel MCP sunucusu

CodeWikiTap, bilgisayarınızda yerel olarak çalışan küçük bir Node/TypeScript uygulamasıdır — bir **Model Context Protocol (MCP) sunucusu**. Kullandığınız kodlama agent'ı (Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, Windsurf) onunla stdio üzerinden konuşur. Sunucu agent'a sabit **beş araçlık** bir yüzey sunar; agent ihtiyaç duyduğunda CodeWiki içeriğini kendi bağlamına çekebilir.

En kısa zihinsel model:

```
       ┌────────────────────────┐
       │   Kodlama agent'ınız   │
       │   bir soru sorar       │
       └────────────┬───────────┘
                    │  stdio (JSON-RPC)
                    ▼
       ┌────────────────────────┐
       │      CodeWikiTap       │   ← yerel, API anahtarı yok, telemetri yok
       │   (MCP sunucusu)       │
       └────────────┬───────────┘
                    │  hibrit arama, indekslenmiş CodeWiki sayfaları
                    ▼
       ┌────────────────────────┐
       │   Google CodeWiki      │   ← üst kaynak, yalnız public repo
       │  (önbellekli, sabit)   │
       └────────────────────────┘
```

"Sadece CodeWiki'yi çek" demek değil — şunları da ekliyor:

- **Proje farkındalığı.** Açılışta manifest dosyanızı (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …) okur, doğrudan bağımlılıklarınızı GitHub depolarına eşler ve her birinin CodeWiki'de karşılığı olup olmadığını yoklar. Agent daha ilk soruyu sormadan, hangi kütüphanenin dokümantasyonu olduğunu bilir.
- **Hibrit arama.** BM25 keyword araması + dense vektör araması → Reciprocal Rank Fusion → cross-encoder ile yeniden sıralama. Her parça için beş ayrı puan döner; sıralama denetlenebilir, kara kutu değildir.
- **Bilgi grafı.** İndeksleme sırasında aynı SQLite işleminde beş tür bağlantı çıkarılır. Agent "`src/auth.ts` dosyasına hangi sayfalar atıf yapıyor?" ya da "`AuthRouter` diyagram düğümüne neler bağlı?" diye sorabilir.
- **Kaynak gösterimi zorunlu.** Her parça ve her sayfa cevabı, kaynak URL'sini ve commit'i içeren değişmez bir alt bilgiyle gelir. Bu alt bilgi testlerle doğrulanır; kapatmanın bir yolu yoktur.
- **Sabit araç yüzeyi.** Sunucu altıncı bir araç kaydetmeyi reddeder. `/(search|ask|query|generate|index|write)/i` ile eşleşen isimler kod seviyesinde geri çevrilir — hiçbir eklenti veya kanca API'yi sessizce genişletemez.

## Neden RAG? Dokümanı doğrudan vermek varken?

Bir CodeWiki sayfası tipik olarak 2.000 – 4.000 token civarındadır. Gerçek bir kütüphanenin onlarcası vardır. Örneğin yazıldığı sırada Next.js'in **18 sayfası**, React'in 40'tan fazlası mevcut. Hepsini agent'ın bağlamına doldurmaya kalkarsanız, daha soruyu okumadan token bütçeniz tükenir.

```
NAİF YAKLAŞIM (RAG yok) — "agent'a her şeyi ver"

   ┌─────────────────────────────────────────────────────────┐
   │ vercel/next.js  CodeWiki = 18 sayfa × ~3.000 tok ≈ 54k  │
   │ facebook/react  CodeWiki = 40+ sayfa × ~3.000 tok ≈ 120k│
   │ prisma/prisma   CodeWiki = 25+ sayfa × ~3.000 tok ≈ 75k │
   │                              ...                        │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼  hepsi prompt'a tıkıştırıldı
              ✗ bağlam patladı · ✗ maliyet fırladı · ✗ alaka gürültüde kayboldu


RAG (CodeWikiTap'in yaptığı)

   54k token Next.js dokümanı
          │
          ▼  başlık sınırlarında parçalandı (canonical tree)
   ~200 parça × ~250 token
          │
          ▼  cache.db'ye bir kez indekslendi
   BM25 (FTS5) ┐
               ├──► RRF füzyonu ──► cross-encoder yeniden sıralama
   dense vec  ─┘                              │
                                              ▼
                          en alakalı K parça (~5 × ~250 tok ≈ 1,2k tok)
                                              │
                                              ▼
                          agent'a kaynak gösterilerek teslim edildi
              ✓ odaklı · ✓ ucuz · ✓ denetlenebilir · ✓ doğrulanabilir
```

### Neden hibrit (BM25 + vektör), tek başına biri değil?

- BM25 tek başına eşanlamlıları kaçırır — "data fetching" sorgusu "remote data loading" başlığını yakalamaz.
- Vektör tek başına tam eşleşme gereken sembolleri kaçırır — `useEffect` ya da `revalidateTag` için keyword kesinliği şarttır.
- Reciprocal Rank Fusion (RRF, k=60) ile birleştirildiğinde her iki yöntemin kör noktası baskın olamaz. Cross-encoder yeniden sıralama, en üstteki adaylar üzerinde tam dikkatle çalışıp her iki yöntemden kalan sıralama hatalarını da düzeltir.

Sonuçta agent'a giden bağlam yükü, ham içeriği olduğu gibi göndermekten kabaca **40–80 kat daha küçük** olur ve isabet ölçülebilir biçimde daha yüksektir (eşikler `tests/eval/` altında kilitli: `NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80`).

## Ne *değildir*

- **Bir yapay zeka modeli değildir.** Paketin içinde gömülü bir model yoktur. CodeWikiTap, agent'ınızın zaten kullandığı yapay zekaya giden **bağlamın kalitesini** iyileştirir.
- **Bir dokümantasyon üreticisi değildir.** İçerik burada üretilmez; Google CodeWiki'nin Gemini ile ürettiği dokümantasyon çekilir.
- **Bir bulut servisi değildir.** Hiçbir veri bilgisayarınızdan çıkmaz. Yerel SQLite önbelleği, yerel ONNX çıkarımı, sıfır telemetri.
- **Google'a ait değildir.** Bağımsız bir açık kaynak projedir; "CodeWiki" adı yalnızca veri kaynağını belirtmek için kullanılır.
- **Özel depolar için uygun değildir.** Google CodeWiki şu anda yalnızca herkese açık GitHub depolarını kapsıyor; özel erişim, bekleme listesindeki bir Gemini CLI eklentisinin arkasında.

---

Sıradaki: [Kurulum](/tr/guide/kurulum) — CodeWikiTap'i agent'ınıza nasıl bağlarsınız.
