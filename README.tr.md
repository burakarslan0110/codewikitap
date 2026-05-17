<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap-mcp/main/assets/banner.png?v=2" alt="CodeWikiTap" width="720"/>
</p>

<h1 align="center">CodeWikiTap</h1>

<p align="center">
  <strong>Google CodeWiki dokümantasyonunu kodlama agent'ına RAG ile akıtan <em>unofficial</em> bir MCP server'ı — parçalanmış, kaynak gösterilmiş, paketin pinli olduğu commit SHA'sına sabitlenmiş şekilde.</strong>
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
  📚 <strong><a href="https://burakarslan0110.github.io/codewikitap-mcp/tr/">Tam dokümantasyon</a></strong> — kavramlar, mimari, 5 araç, yapılandırma referansı, sorun giderme.
</p>

```bash
npx codewikitap install
```

---

## Ne işe yarar?

<p align="center">
  <img src="https://raw.githubusercontent.com/burakarslan0110/codewikitap-mcp/main/assets/logo-mark.png" alt="CodeWikiTap logosu" width="360"/>
</p>

Makinende lokal çalışan küçük bir Node programı — bir [**MCP server**](https://modelcontextprotocol.io). Kodlama agent'ın (Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, Windsurf) onunla stdio üzerinden konuşur ve server **5 araç** sunar; agent ihtiyaç duyduğu anda [Google CodeWiki](https://codewiki.google) dokümantasyonunu context'ine çekebilir — heading sınırlarında parçalanmış, hybrid BM25 + vector + cross-encoder rerank ile skorlanmış, byte-equal citation footer ile damgalanmış olarak.

```
   ┌─────────────────┐  stdio    ┌──────────────────┐  hybrid retrieval   ┌────────────────┐
   │ Kodlama agent'ı │ ────────► │   CodeWikiTap    │ ──────────────────► │ Google CodeWiki │
   │ soru sorar      │           │  (lokal server)  │  cache'li, SHA-pinli│ (yalnız public) │
   └─────────────────┘           └──────────────────┘                     └────────────────┘
                                  API key yok · telemetri yok
```

**Neden RAG, "doğrudan doc'u fetch'le" değil?** Tipik bir CodeWiki sayfası 2–4 k token; Next.js'in tek başına 18 sayfası var. Naif enjeksiyon, daha soruyu okumadan context bütçesini patlatır. CodeWikiTap her biri ~250 token'lık ~5 chunk döndürür — yaklaşık **40–80× daha küçük** ve daha yüksek recall ile (regression-locked: `NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80`).

## Hızlı kurulum

```bash
npx codewikitap install
```

İnteraktif sihirbaz target ve scope sorar, diff gösterir ve config'i atomik olarak `.bak` yedeğiyle yazar. Script kullanımı için:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
```

| Agent | Config yolu |
|---|---|
| Claude Code | `~/.claude/mcp.json` veya proje `.mcp.json` (veya [plugin marketplace](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/kurulum#claude-code)) |
| Cursor | `~/.cursor/mcp.json` veya `<proje>/.cursor/mcp.json` |
| VS Code | `<proje>/.vscode/mcp.json` veya platforma göre user dir (Linux `~/.config/Code/User/mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`) |
| Codex CLI | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| Qwen Code | `~/.qwen/settings.json` |
| opencode | `opencode.json` veya `~/.config/opencode/opencode.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` |

Agent başına tam config blokları [Kurulum kılavuzu](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/kurulum)'nda.

**Gereksinimler:** Node ≥ 22.5, ~150 MB disk (Playwright shell + ONNX modelleri + cache). İlk çalıştırma `chromium-headless-shell` (~30 MB) ve embedder/reranker modellerini (~50 MB) indirir — ikisi de tek seferlik, kalıcı cache'lenir.

## Örnek — Next.js cache muamması

> *"`revalidatePath` çağrım neden cache'lenmiş fetch'i yenilemiyor?"*

```
   Agent'ın tool trace'i
   ──────────────────────────────────────────────────────────
   1. list_project_dependencies  → next → vercel/next.js, 18 sayfa indexli
   2. find_chunks({ query: "revalidatePath cached fetch", repos: ["vercel/next.js"] })
                                 → top chunk: "On-demand revalidation",
                                   rrfScore 0.84, rerankScore 9.2
   3. get_page({ slug: "app-router/caching", subsection: "on-demand-revalidation" })
                                 → revalidatePath(path, type) imzasıyla tam Markdown
   4. find_neighbors({ source: "node", id: "RouteCache" })
                                 → FullRouteCache, DataCache, RouterCache, RequestMemoization
   ──────────────────────────────────────────────────────────
   Cevap:
     "revalidatePath(path) tek başına yalnız route segment cache'i invalidate eder.
      force-cache fetch'in Data Cache'te yaşar — revalidatePath(path, 'page') kullan
      veya fetch'i tag'leyip revalidateTag(tag) çağır.   — commit a1b2c3d'ye pinli"
```

Daha fazla örnek [Araçlar kılavuzu](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/araclar#gercek-senaryolar)'nda.

## Desteklenen projeler

**Dokuz ecosystem**, on beş manifest parser: JavaScript / TypeScript, Python, Go, Rust, PHP, Java (Maven), Java (Gradle), Ruby, .NET. Workspace traversal, BOM imports, parent POM resolution mevcut. Tam matris → [Kurulum kılavuzu](https://burakarslan0110.github.io/codewikitap-mcp/tr/guide/kurulum#desteklenen-proje-turleri).

## Ne *değildir*

- **Bir AI modeli değildir.** İçinde bundle'lı model yok. CodeWikiTap, agent'ın zaten kullandığı AI'a giden **context kalitesini** iyileştirir.
- **Cloud servisi değildir.** Hiçbir şey makinenden çıkmaz. Lokal SQLite, lokal ONNX inference, sıfır telemetri.
- **Google ile bağlantılı değildir.** Bağımsız open-source proje; "CodeWiki" adı yalnızca veri kaynağı olarak betimleyici şekilde geçer.
- **Private repo için değildir.** Google CodeWiki şu an yalnız public GitHub repolarını kapsar.

## Daha fazla

- 📚 **[Dokümantasyon](https://burakarslan0110.github.io/codewikitap-mcp/tr/)** — kavramlar, mimari, 5 araç, yapılandırma referansı
- 📜 **[CHANGELOG](CHANGELOG.md)** — neyin ne zaman değiştiği
- 🤝 **[Katkı](CONTRIBUTING.md)** — pnpm toolchain, test akışı, release süreci
- 🔐 **[Güvenlik](SECURITY.md)** — açıklıkları lütfen public issue olarak açma

## Lisans

[MIT](LICENSE) — © 2026 Burak Arslan.

> CodeWikiTap bağımsız, **unofficial** bir projedir. Google ile bağlantılı değildir; Google tarafından onaylanmamış veya desteklenmemiştir. "CodeWiki" adı yalnızca upstream veri kaynağı olarak betimleyici şekilde geçer.
