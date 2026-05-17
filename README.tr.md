<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap-mcp/main/assets/banner.png?v=2" alt="CodeWikiTap" width="720"/>
</p>

<h1 align="center">CodeWikiTap</h1>

<p align="center">
  <strong>Google CodeWiki dokümantasyonunu kodlama agent'ına taşıyan <em>resmi olmayan</em> bir MCP sunucusu. İçerik parçalara bölünüp kaynağıyla birlikte, paketinizin sabitlendiği commit'e dayanarak getirilir.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codewikitap"><img src="https://img.shields.io/npm/v/codewikitap?color=1D4ED8&label=npm" alt="npm"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1D4ED8.svg" alt="MIT"/></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white" alt="Node ≥22.5"/>
  <a href="https://github.com/burakarslan0110/codewikitap-mcp/actions"><img src="https://github.com/burakarslan0110/codewikitap-mcp/actions/workflows/ci.yml/badge.svg" alt="CI"/></a>
  <img src="https://img.shields.io/badge/status-unofficial-orange" alt="Unofficial"/>
</p>

<p align="center">
  <a href="README.md">🇬🇧 English</a> · 🇹🇷 <strong>Türkçe</strong>
</p>

<p align="center">
  📚 <strong><a href="https://burakarslan0110.github.io/codewikitap-mcp/tr/">Tüm dokümantasyon</a></strong> — kavramlar, mimari, araçlar, yapılandırma ve sorun giderme.
</p>

```bash
npx codewikitap install
```

---

## Ne işe yarar?

<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap-mcp/main/assets/logo-mark.png" alt="CodeWikiTap logosu" width="360"/>
</p>

CodeWikiTap, bilgisayarınızda yerel olarak çalışan küçük bir Node uygulamasıdır; bir [**MCP sunucusu**](https://modelcontextprotocol.io). Kullandığınız kodlama agent'ı (Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, Windsurf) bu sunucuyla stdio üzerinden konuşur. Sunucu agent'a **beş araç** sunar; agent ihtiyaç duyduğu anda [Google CodeWiki](https://codewiki.google) dokümantasyonunu kendi bağlamına çekebilir. İçerik başlık sınırlarında parçalara bölünmüş, BM25 + vektör arama + cross-encoder yeniden sıralama ile puanlanmış ve her parçanın altına kaynağa bağlanan değişmez bir alt bilgi eklenmiş olarak gelir.

```
   ┌─────────────────┐  stdio    ┌──────────────────┐  hibrit arama       ┌──────────────────┐
   │ Kodlama agent'ı │ ────────► │   CodeWikiTap    │ ──────────────────► │ Google CodeWiki  │
   │ soru sorar      │           │  (yerel sunucu)  │  önbellekli, sabit  │ (yalnız public)  │
   └─────────────────┘           └──────────────────┘                     └──────────────────┘
                                  API anahtarı yok · telemetri yok
```

**Neden hazır içeriği doğrudan vermek yerine RAG?** Tipik bir CodeWiki sayfası 2–4 bin token tutuyor; tek başına Next.js'in 18 sayfası var. Hepsini olduğu gibi bağlama doldurmak, daha ilk soruya gelmeden bütçenizi tüketir. CodeWikiTap bunun yerine ortalama 250 token'lık 5 küçük parça döndürür — **40–80 kat daha küçük** bir yük, ölçülebilir biçimde daha yüksek isabet (`NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80` eşikleri test ile kilitli).

## Hızlı kurulum

```bash
npx codewikitap install
```

Adım adım soran sihirbaz hangi agent'ı ve hangi kapsamı kullanmak istediğinizi sorar, değişikliği gösterir, onay aldıktan sonra yapılandırma dosyasını `.bak` yedeğini bırakarak atomik biçimde yazar. Komut satırından çalıştırmak isterseniz:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
```

| Agent | Yapılandırma dosyası |
|---|---|
| Claude Code | `~/.claude/mcp.json` ya da projedeki `.mcp.json` (alternatif olarak [plugin marketplace](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/kurulum#claude-code)) |
| Cursor | `~/.cursor/mcp.json` ya da `<proje>/.cursor/mcp.json` |
| VS Code | `<proje>/.vscode/mcp.json` ya da işletim sistemine göre kullanıcı dizini (Linux `~/.config/Code/User/mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`) |
| Codex CLI | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| Qwen Code | `~/.qwen/settings.json` |
| opencode | `opencode.json` ya da `~/.config/opencode/opencode.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |

Her agent için tam yapılandırma blokları [Kurulum kılavuzunda](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/kurulum).

**Sistem gereksinimleri:** Node 22.5 ve üzeri, yaklaşık 150 MB boş alan (Playwright shell + ONNX modelleri + önbellek). İlk açılışta `chromium-headless-shell` (~30 MB) ve gömme/yeniden sıralama modelleri (~50 MB) indirilir; her ikisi de tek seferlik bir işlemdir ve diskte kalıcı olarak saklanır.

## Örnek — Next.js cache bilmecesi

> *"`revalidatePath` çağrım neden cache'lenmiş fetch'i tazelemiyor?"*

```
   Agent'ın araç akışı
   ──────────────────────────────────────────────────────────
   1. list_project_dependencies  → next → vercel/next.js, 18 sayfa hazır
   2. find_chunks({ query: "revalidatePath cached fetch", repos: ["vercel/next.js"] })
                                 → en alakalı parça: "On-demand revalidation",
                                   rrfScore 0.84, rerankScore 9.2
   3. get_page({ slug: "app-router/caching", subsection: "on-demand-revalidation" })
                                 → revalidatePath(path, type) imzasıyla tam Markdown
   4. find_neighbors({ source: "node", id: "RouteCache" })
                                 → FullRouteCache, DataCache, RouterCache, RequestMemoization
   ──────────────────────────────────────────────────────────
   Cevap:
     "revalidatePath(path) tek başına yalnızca route segment cache'ini geçersiz kılar.
      force-cache fetch'iniz Data Cache'te durur — revalidatePath(path, 'page') çağırın
      ya da fetch'i tag'leyip revalidateTag(tag) kullanın.   — kaynak: commit a1b2c3d"
```

Daha fazla örnek için [Araçlar kılavuzuna](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/araclar#gercek-senaryolar) bakın.

## Desteklenen projeler

Dokuz ekosistem ve toplam on beş manifest okuyucu: JavaScript / TypeScript, Python, Go, Rust, PHP, Java (Maven), Java (Gradle), Ruby ve .NET. Monorepo workspace'leri, BOM içe aktarımları ve üst POM çözümleri destekleniyor. Tüm liste için [Kurulum kılavuzuna](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/kurulum#desteklenen-proje-turleri) bakın.

## Ne *değildir*

- **Bir yapay zeka modeli değildir.** Paketin içinde gömülü bir model yoktur; CodeWikiTap zaten kullandığınız agent'ın yapay zekasına giden **bağlamın kalitesini** iyileştirir.
- **Bir bulut servisi değildir.** Hiçbir veri bilgisayarınızdan dışarı çıkmaz. Yerel SQLite önbelleği, yerel ONNX çıkarımı, sıfır telemetri.
- **Google'a ait değildir.** Bağımsız bir açık kaynak projedir; "CodeWiki" adı yalnızca veri kaynağını belirtmek için kullanılır.
- **Özel (private) depolar için uygun değildir.** Google CodeWiki şu anda yalnızca herkese açık GitHub depolarını kapsıyor.

## Daha fazla bilgi

- 📚 **[Dokümantasyon](https://burakarslan0110.github.io/codewikitap-mcp/tr/)** — kavramlar, mimari, araçlar, yapılandırma referansı
- 📜 **[CHANGELOG](CHANGELOG.md)** — sürüm geçmişi
- 🤝 **[Katkı rehberi](CONTRIBUTING.md)** — pnpm araç zinciri, test akışı, sürüm süreci
- 🔐 **[Güvenlik](SECURITY.md)** — güvenlik açıklarını lütfen herkese açık issue olarak bildirmeyin

## Lisans

[MIT](LICENSE) — © 2026 Burak Arslan.

> CodeWikiTap bağımsız ve **resmi olmayan** bir projedir; Google ile herhangi bir bağı yoktur, Google tarafından onaylanmamıştır. "CodeWiki" adı yalnızca üst kaynaktaki içeriği belirtmek amacıyla kullanılmaktadır.
