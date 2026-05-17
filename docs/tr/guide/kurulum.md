# Kurulum

İlk çalıştırmada Playwright'ın `chromium-headless-shell` paketi (~30 MB) indirilir — CodeWiki bir Angular tek sayfa uygulaması olduğu için düz bir HTTP isteği boş bir shell döndürür; gerçek bir tarayıcı şarttır. İlk `find_chunks` çağrısında da ONNX gömme ve yeniden sıralama modelleri (toplam ~50 MB) inerek diske düşer. Her iki indirme de tek seferliktir ve kalıcı olarak önbelleğe alınır.

`codewikitap`'i doğrudan elinizle çalıştırmazsınız — agent onu bir alt süreç olarak başlatır.

## Sistem gereksinimleri

| | En az |
|---|---|
| **Node.js** | 22.5.0 |
| **İşletim sistemi** | macOS, Linux, Windows |
| **Disk** | ~150 MB (Playwright shell + ONNX modelleri + indeks önbelleği) |
| **Ağ** | Yalnızca ilk açılışta (Playwright + modeller); sonraki sorgular 24 saatte bir yapılan SHA kontrolüne kadar tamamen yereldir |

## Adım adım kurulum (önerilen)

```bash
npx codewikitap install
```

Sihirbaz hangi agent'ı ve hangi kapsamı kullanmak istediğinizi sorar; halihazırda bir kayıt varsa farkı gösterip onay alır; uygun yapılandırma dosyasını `.bak` yedeği bırakarak atomik biçimde yazar.

Komut satırından ya da CI içinden çalıştırmak isterseniz tüm sorular bayraklarla geçilebilir:

```bash
npx codewikitap install --target=claude-code --scope=user --yes
npx codewikitap install --target=cursor --scope=project --dry-run    # ön izleme, dosyaya dokunmaz
```

Geçerli `--target` değerleri: `claude-code`, `cursor`, `vscode`, `codex-cli`, `gemini-cli`, `qwen-code`, `opencode`, `windsurf`, `antigravity`. Geçerli `--scope` değerleri: `project`, `user` (bazı agent'lar yalnızca kullanıcı kapsamını destekler — sihirbaz bunu otomatik seçer).

## Alternatif kurulum yöntemleri

| Agent | Yöntem | Dosya |
|---|---|---|
| Claude Code | Plugin marketplace | `/plugin marketplace add burakarslan0110/codewikitap-mcp` → `/plugin install codewikitap@burakarslan0110-codewikitap` |
| Claude Code | Elle JSON | `~/.claude/mcp.json` ya da proje kökünde `.mcp.json` |
| Cursor | Elle JSON | `~/.cursor/mcp.json` ya da `<proje>/.cursor/mcp.json` |
| VS Code | Elle JSON | `<proje>/.vscode/mcp.json` ya da işletim sistemine göre kullanıcı dizini (Linux `~/.config/Code/User/mcp.json`, macOS `~/Library/Application Support/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`) |
| Codex CLI | Elle TOML | `~/.codex/config.toml` |
| Gemini CLI | Elle JSON | `~/.gemini/settings.json` |
| Qwen Code | Elle JSON | `~/.qwen/settings.json` ya da projedeki karşılığı |
| opencode | Elle JSON | `opencode.json` ya da `~/.config/opencode/opencode.json` |
| Windsurf | Elle JSON | `~/.codeium/windsurf/mcp_config.json` |
| Antigravity | Elle JSON | `~/.gemini/antigravity/mcp_config.json` |

Önerilen yol sihirbazdır — farkı gösterme, yedek alma ve atomik yazma işlerini sizin için halleder. Aşağıdaki bloklar referans amaçlıdır.

### Claude Code

`~/.claude/mcp.json` (kullanıcı kapsamı) ya da proje kökünde `.mcp.json`:

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

Ya da Claude plugin marketplace üzerinden:

```text
/plugin marketplace add burakarslan0110/codewikitap-mcp
/plugin install codewikitap@burakarslan0110-codewikitap
```

### Cursor

`~/.cursor/mcp.json` ya da `<proje>/.cursor/mcp.json` — Claude Code ile aynı JSON yapısı.

### VS Code

`<proje>/.vscode/mcp.json` (workspace) ya da VS Code'un kullanıcı veri dizini (Command Palette'ten `MCP: Open User Configuration`). VS Code, `mcpServers` yerine `servers.<name>` kullanır ve her stdio kaydında ayırt edici bir `type` alanı bulunur:

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

Kullanıcı kapsamındaki yol işletim sistemine göre değişir: Linux'ta `~/.config/Code/User/mcp.json` (`XDG_CONFIG_HOME` ortam değişkenini dikkate alır), macOS'ta `~/Library/Application Support/Code/User/mcp.json`, Windows'ta `%APPDATA%\Code\User\mcp.json`. `npx codewikitap install --target=vscode` sihirbazı üç durumu da kendi başına halleder.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.codewikitap]
command = "npx"
args = ["-y", "codewikitap"]
```

### Gemini CLI

`~/.gemini/settings.json` içindeki `mcpServers` bloğunun altında — Claude Code yapısıyla birebir aynı.

### Qwen Code

`~/.qwen/settings.json` ya da `<proje>/.qwen/settings.json` — Claude Code ile aynı JSON yapısı.

### opencode

`opencode.json` (proje) ya da `~/.config/opencode/opencode.json` (kullanıcı). opencode, `mcpServers` yerine `mcp.<name>` kullanır ve her kayıtta `type` alanı zorunludur:

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

`~/.codeium/windsurf/mcp_config.json` — Claude Code ile aynı JSON yapısı. Yalnız kullanıcı kapsamı destekleniyor (proje kapsamı üst akışta belgelenmemiş).

### Antigravity

`~/.gemini/antigravity/mcp_config.json` — Claude Code ile aynı JSON yapısı. Yalnız kullanıcı kapsamı.

## Desteklenen proje türleri

CodeWikiTap, projenizi "tanımak" için manifest dosyasını okur. **Dokuz ekosistem** tam desteklenir, gerektiğinde workspace gezintisiyle birlikte. Bu ekosistemleri toplam on beş manifest okuyucu kapsar:

| Ekosistem | Manifest | Workspace / ek özellikler |
|---|---|---|
| **JavaScript / TypeScript** | `package.json` | npm/pnpm/yarn `workspaces`, `pnpm-workspace.yaml` |
| **Python** | `requirements.txt`, `pyproject.toml` | PEP 621 + Poetry |
| **Go** | `go.mod`, `go.work` | tam workspace farkındalığı |
| **Rust** | `Cargo.toml` | `[workspace] members` (literal + glob) |
| **PHP** | `composer.json` | platform paketleri otomatik elenir |
| **Java (Maven)** | `pom.xml` | tam property çözümü + döngüye karşı korumalı tekrarlı BOM içe aktarımı + `<parent>` POM + `<modules>` aggregator gezintisi |
| **Java (Gradle)** | `gradle/libs.versions.toml` | `settings.gradle(.kts)` üzerinden alt proje keşfi + her alt proje için `build.gradle(.kts)` ayrıştırma |
| **Ruby** | `Gemfile.lock` (tercih edilen) | `Gemfile` için regex bazlı yedek |
| **.NET** | `*.csproj` + `Directory.Packages.props` | CPM + `*.sln` üzerinden çözümlü keşif |

Sohbette "react" demeniz yeterli — çözücü onu `facebook/react`'a eşler. Maven Central, RubyGems, NuGet, crates.io, Packagist ve npm registry'lerinin hepsi entegre.

## Çalıştığını doğrulamak

Kurulumdan sonra agent'ınızı yeniden başlatın ve sorun:

> Hangi bağımlılıklarımın CodeWiki kapsamı var?

Agent kendiliğinden `list_project_dependencies`'i çağırıp bağımlılık bazlı bir kapsam raporu döndürmelidir. Eğer "MCP server kayıtlı değil" yazısını görürseniz, yapılandırma dosyası yazıldı ama agent yeniden yüklenmedi demektir — agent'ı tamamen kapatıp yeniden açın.

Sorun gidermek için (soğuk başlangıç hataları, `-32000`, eksik prebuilt'ler vb.) [Yapılandırma → Sorun giderme](/tr/guide/yapilandirma#sorun-giderme) bölümüne bakın.

---

Sıradaki: [Mimari](/tr/guide/mimari) — kaputun altında neler dönüyor.
