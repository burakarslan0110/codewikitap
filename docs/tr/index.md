---
layout: home

hero:
  name: CodeWikiTap
  text: Google CodeWiki, doğrudan agent'ında.
  tagline: Google CodeWiki dokümantasyonunu kodlama agent'ına RAG ile akıtan unofficial bir MCP server'ı — parçalanmış, kaynak gösterilmiş, paketin pinli olduğu commit SHA'sına sabitlenmiş şekilde.
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
    details: Açılışta manifest'ini (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …) tarar, direct dependency'lerini GitHub repolarına çözer ve her birinde CodeWiki kapsamı olup olmadığını yoklar — agent ilk soruyu sormadan önce.
  - icon: 🔎
    title: Hybrid retrieval
    details: BM25 (FTS5) + dense vector (sqlite-vec), Reciprocal Rank Fusion ile birleştirilir ve cross-encoder ile yeniden sıralanır. Her chunk için beş skor — sıralama denetlenebilir, kara kutu değil.
  - icon: 🕸️
    title: Knowledge graph
    details: Aynı SQLite transaction'ında beş tipte edge çıkarılır — `code_ref`, `diagram_edge`, `diagram_member`, `section_link`, `cross_repo_ref`. "Buna ne bağlı?" diye sorabilirsin.
  - icon: 🔗
    title: Citation zorunlu
    details: Her chunk ve her sayfa, source URL ile commit SHA'yı taşıyan byte-equal bir footer ile gelir. Test'lerle assert'lenir; susturmanın yolu yok.
  - icon: 🔒
    title: Lokal-first
    details: SQLite cache, ONNX inference, sıfır telemetri. API key yok. Tek network trafiği CodeWiki'nin kendisine.
  - icon: 🧩
    title: 9 agent destekli
    details: Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Windsurf, Antigravity. Tek interaktif sihirbaz her birine doğru config bloğunu yazar.
---

## Hızlı kurulum

```bash
npx codewikitap install
```

Agent'ını seç, scope'u seç, bitti. Sihirbaz config'i atomik olarak `.bak` yedeğiyle yazar.

## Neden CodeWikiTap?

Tipik bir CodeWiki sayfası 2.000–4.000 token. Gerçek bir kütüphanenin onlarcası vardır — Next.js'in 18 sayfası var (~54 k token), React'in 40'tan fazla. Hepsini agent'ın context'ine doldurmak, daha ilk soruya bile geçemeden token bütçesini bitirir.

CodeWikiTap odaklı, citation taşıyan chunk'lar verir (~5 × ~250 token ≈ 1,2 k token), naif enjeksiyona göre **40–80× daha küçük**, ölçülebilir biçimde daha yüksek recall ile.

::: tip Dokümantasyon
Bu site, public yüzeyi ve tasarımı belgeler. Kavramsal model için [CodeWikiTap nedir?](/tr/guide/kavramlar) ile devam et, doğrudan [Kurulum](/tr/guide/kurulum)'a atla.
:::

> CodeWikiTap bağımsız, **unofficial** bir projedir. Google ile bağlantılı değildir; Google tarafından onaylanmamış veya desteklenmemiştir. "CodeWiki" adı yalnızca upstream veri kaynağı olarak betimleyici şekilde geçer.

---

<p align="center"><sub><a href="https://github.com/burakarslan0110">Burak Arslan</a> tarafından geliştirilmiştir</sub></p>
