# Kurulum

İlk çalıştırmada Playwright'ın `chromium-headless-shell`'i (~30 MB) indirilir — CodeWiki Angular SPA olduğu için düz HTTP isteği boş bir shell döndürür, gerçek browser şart. İlk `find_chunks` çağrısında ONNX embedder + reranker modelleri (toplam ~50 MB) iner. İkisi de tek seferlik, kalıcı cache'lenir.

`codewikitap`'i doğrudan çalıştırmazsın — agent onu bir child process olarak başlatır.

## Gereksinimler

| | Minimum |
|---|---|
| **Node.js** | 22.5.0 |
| **İşletim sistemi** | macOS, Linux, Windows |
| **Disk** | ~150 MB (Playwright shell + ONNX modelleri + index cache) |
| **Network** | Yalnız ilk çalıştırmada (Playwright + modeller); sonraki sorgular 24 saatlik SHA probe gelene kadar lokal |

## İnteraktif kurulum (önerilen)

```bash
npx codewikitap install
```

Sihirbaz hangi agent ve hangi scope sorar; mevcut bir entry varsa diff gösterip onay alır; uygun config dosyasını atomik olarak `.bak` yedeğiyle yazar.

Script / CI kullanımı için tüm sorular flag ile geçilebilir:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
npx codewikitap install --target=cursor --scope=project --dry-run    # önizleme, dosyaya dokunmaz
```

Geçerli `--target` değerleri: `claude-code`, `cursor`, `vscode`, `codex-cli`, `gemini-cli`, `qwen-code`, `opencode`, `windsurf`, `antigravity`. Geçerli `--scope` değerleri: `project`, `user` (bazı hedefler user-only — sihirbaz otomatik seçer).

## Alternatif kurulum yöntemleri

| Agent | Yöntem | Yol |
|---|---|---|
| Claude Code | Plugin marketplace | `/plugin marketplace add burakarslan0110/codewikitap-mcp` → `/plugin install codewikitap@burakarslan0110-codewikitap` |
| Claude Code | Manuel JSON | `~/.claude/mcp.json` veya proje kökünde `.mcp.json` |
| Cursor | Manuel JSON | `~/.cursor/mcp.json` veya `<proje>/.cursor/mcp.json` |
| VS Code | Manuel JSON | `<proje>/.vscode/mcp.json` veya platforma göre user dir (Linux `~/.config/Code/User/mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`) |
| Codex CLI | Manuel TOML | `~/.codex/config.toml` |
| Gemini CLI | Manuel JSON | `~/.gemini/settings.json` |
| Qwen Code | Manuel JSON | `~/.qwen/settings.json` veya proje karşılığı |
| opencode | Manuel JSON | `opencode.json` veya `~/.config/opencode/opencode.json` |
| Windsurf | Manuel JSON | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity | Manuel JSON | `~/.gemini/antigravity/mcp_config.json` |

İnteraktif sihirbaz önerilen yoldur — diff, backup ve atomik yazımı senin için halleder. Aşağıdaki bloklar referans için.

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
/plugin marketplace add burakarslan0110/codewikitap-mcp
/plugin install codewikitap@burakarslan0110-codewikitap
```

### Cursor

`~/.cursor/mcp.json` veya `<proje>/.cursor/mcp.json` — Claude Code ile aynı JSON şekli.

### VS Code

`<proje>/.vscode/mcp.json` (workspace) veya VS Code'un user data dir'i (Command Palette'ten `MCP: Open User Configuration`). VS Code `mcpServers` değil `servers.<name>` kullanır ve her stdio entry'sinin `type` ayırt edici alanı vardır:

```json
{
  "servers": {
    "codewikitap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "codewikitap"]
    }
  }
}
```

User-scope yolu OS'a göre değişir: Linux'ta `~/.config/Code/User/mcp.json` (`XDG_CONFIG_HOME`'u dikkate alır), macOS'ta `~/Library/Application Support/Code/User/mcp.json`, Windows'ta `%APPDATA%\Code\User\mcp.json`. `npx codewikitap install --target=vscode` sihirbazı üçünü de otomatik halleder.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.codewikitap]
command = "npx"
args = ["-y", "codewikitap"]
```

### Gemini CLI

`~/.gemini/settings.json` içinde `mcpServers` altına — Claude Code şekliyle birebir aynı.

### Qwen Code

`~/.qwen/settings.json` veya `<proje>/.qwen/settings.json` — Claude Code ile aynı JSON şekli.

### opencode

`opencode.json` (proje) veya `~/.config/opencode/opencode.json` (user). opencode `mcpServers` değil `mcp.<name>` kullanır ve her entry'de `type` ayırt edici alanı gerekir:

```json
{
  "mcp": {
    "codewikitap": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "codewikitap"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` — Claude Code ile aynı JSON şekli. Sadece user scope (proje scope üst akıştan dokümante edilmemiş).

### Antigravity

`~/.gemini/antigravity/mcp_config.json` — Claude Code ile aynı JSON şekli. Sadece user scope.

## Desteklenen proje türleri

CodeWikiTap projeni "tanımak" için manifest'i okur. **Dokuz ecosystem**'de tam destek var, gerektiğinde workspace traversal ile. On beş ayrı manifest parser bunları kapsar:

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

## Çalıştığını doğrulamak

Kurulumdan sonra agent'ını yeniden başlat ve sor:

> Hangi bağımlılıklarımın CodeWiki kapsamı var?

Agent otomatik olarak `list_project_dependencies`'i çağırıp dep bazlı bir kapsam raporu döndürmeli. "MCP server kayıtlı değil" görüyorsan, config dosyası yazıldı ama agent yeniden yüklenmedi — agent'ı tam kapatıp yeniden aç.

Sorun giderme için (cold-start hataları, `-32000`, eksik prebuilt'ler) [Yapılandırma → Sorun giderme](/tr/guide/yapilandirma#sorun-giderme)'ye bak.

---

Sıradaki: [Mimari](/tr/guide/mimari) — kaputun altında neler dönüyor.
