---
layout: home

hero:
  name: CodeWikiTap
  text: Google CodeWiki, doğrudan agent'ınızın içinde.
  tagline: Google CodeWiki dokümantasyonunu kodlama agent'ınıza taşıyan resmi olmayan bir MCP sunucusu. İçerik parçalara bölünüp kaynak gösterilerek, bağımlılığınızın sabitlendiği commit'e dayanarak getirilir.
  actions:
    - theme: brand
      text: Başla
      link: /tr/guide/kurulum
    - theme: alt
      text: Nedir?
      link: /tr/guide/kavramlar
    - theme: alt
      text: GitHub
      link: https://github.com/burakarslan0110/codewikitap-mcp

features:
  - icon: 📚
    title: Proje farkındalığı
    details: Açılışta projenizin manifest dosyasını (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …) okur, doğrudan bağımlılıklarınızı GitHub depolarına eşler ve her birinin CodeWiki'de karşılığı olup olmadığını kontrol eder — agent ilk soruyu duymadan.
  - icon: 🔎
    title: Hibrit arama
    details: BM25 (FTS5) ile dense vektör araması (sqlite-vec) Reciprocal Rank Fusion ile birleştirilir, ardından cross-encoder ile yeniden sıralanır. Her parça için beş ayrı puan döner — sıralama denetlenebilir, kara kutu değildir.
  - icon: 🕸️
    title: Bilgi grafı
    details: Aynı SQLite işleminde beş ayrı bağlantı türü çıkarılır — `code_ref`, `diagram_edge`, `diagram_member`, `section_link`, `cross_repo_ref`. "Bu kod parçasına ne bağlı?" diye sorabilirsiniz.
  - icon: 🔗
    title: Kaynak gösterimi zorunlu
    details: Her parça ve her sayfa, kaynak URL'sini ve sabitlenmiş commit'i içeren değişmez bir alt bilgiyle gelir. Testler bunu doğrular; bu alt bilgiyi kapatmanın bir yolu yoktur.
  - icon: 🔒
    title: Yerel öncelikli
    details: SQLite önbelleği, ONNX çıkarımı, sıfır telemetri. API anahtarı yok. Tek dış trafik CodeWiki'nin kendisinedir.
  - icon: 🧩
    title: 9 agent desteği
    details: Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Windsurf, Antigravity. Tek bir sihirbaz her birine uygun yapılandırma bloğunu yazar.
---

## Hızlı kurulum

```bash
npx codewikitap install
```

Agent'ınızı seçin, kapsamı belirleyin, bitti. Sihirbaz yapılandırmayı `.bak` yedeği bırakarak atomik biçimde yazar.

## Neden CodeWikiTap?

Tipik bir CodeWiki sayfası 2.000–4.000 token tutar. Gerçek bir kütüphanenin onlarcası vardır — yalnızca Next.js'in 18 sayfası (~54 bin token), React'in 40'tan fazlası var. Hepsini agent'ın bağlamına doldurmak, daha ilk sorunun cevabına gelmeden bütçeyi tüketir.

CodeWikiTap bunun yerine odaklı, kaynak gösteren küçük parçalar verir (yaklaşık 5 × 250 token ≈ 1,2 bin token). Bu, ham içeriği olduğu gibi göndermekten **40–80 kat daha küçük** bir yük; üstelik ölçülebilir biçimde daha yüksek isabet sağlar.

::: tip Dokümantasyon
Bu site projenin tüm yüzünü ve tasarımını anlatır. Kavramsal arka plan için [CodeWikiTap nedir?](/tr/guide/kavramlar) sayfasına bakabilir ya da doğrudan [Kurulum](/tr/guide/kurulum) ile başlayabilirsiniz.
:::

> CodeWikiTap bağımsız ve **resmi olmayan** bir projedir; Google ile herhangi bir bağı yoktur, Google tarafından onaylanmamıştır. "CodeWiki" adı yalnızca üst kaynaktaki içeriği belirtmek amacıyla kullanılmaktadır.

---

<p align="center"><sub><a href="https://github.com/burakarslan0110">Burak Arslan</a> tarafından geliştirilmiştir</sub></p>
