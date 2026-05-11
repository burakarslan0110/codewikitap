![CodeWiKiTap](https://raw.githubusercontent.com/burakarslan0110/codewikitap/main/assets/logo.png)

# CodeWiKiTap

**Kullandığın kütüphanelerin güncel ve doğrulanmış dokümantasyonunu kodlama ajanına bağlam olarak sağlar.**

[![npm version](https://img.shields.io/npm/v/codewikitap?color=blue)](https://www.npmjs.com/package/codewikitap)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-20.x-339933?logo=node.js&logoColor=white)](.nvmrc)
[![CI](https://github.com/burakarslan0110/codewikitap/actions/workflows/ci.yml/badge.svg)](https://github.com/burakarslan0110/codewikitap/actions)

[🇬🇧 English](README.md) · 🇹🇷 **Türkçe**

```bash
npx codewikitap
```

---

## Bunu neden kullanmalısınız?

Claude Code, Cursor, Codex CLI veya Gemini CLI gibi kodlama ajanlarıyla çalışırken sıkça karşılaşılan bir senaryo var: ajana "Next.js'in App Router cache'i nasıl davranır?" diye sorduğunuzda ajan çoğu zaman tahmine dayalı yanıt verir — eğitim verisinden hatırladığı, zaman içinde eskimiş olabilecek bir bilgiyle. Doğrulamak için Next.js dokümanlarını kendiniz açmanız gerekir.

**CodeWiKiTap bu boşluğu kapatır.** Projenizdeki her doğrudan bağımlılık için [Google CodeWiki](https://codewiki.google) üzerinde mevcut olan teknik dokümantasyonu — her PR birleşmesinde Gemini ile yeniden üretilen, depoya göre doğrulanmış belgeler — ajana otomatik bağlam olarak sunar. Sonuç: tahmin yerine **kaynak gösteren, alıntılı, doğrulanabilir** cevaplar.

### Somut kazançlar

| Önce | Sonra |
|---|---|
| Ajan tahminde bulunur, zaman zaman güncel olmayan veya yanlış bilgi verir | Ajan resmi dokümandan okur, kaynağına bağlantı verir |
| Eğitim verisindeki eski Stack Overflow cevaplarına göre öneri yapar | Her PR'da yenilenen, depoya pinlenen güncel dokümana bakar |
| "Hangi kütüphanenin dokümanı var?" sorusuna sizin cevap vermeniz beklenir | Açılış anında projedeki tüm bağımlılıkları tarar, hangilerinde CodeWiki kapsamı olduğunu döker |
| Manuel olarak Next.js / React / Prisma dokümanını açıp ajana yapıştırırsınız | Ajan tek araç çağrısıyla doğru sayfa veya alt-bölüme iner, alıntılı parçayı getirir |

Tek satır kurulum (`npx codewikitap`), API anahtarı yok, bulut bağımlılığı yok, telemetri yok. Her şey yerel makinenizde çalışır.

### context7'den farkı ne?

[context7](https://github.com/upstash/context7) yaygın kütüphanelerin önceden indekslenmiş dokümantasyonunu kullanır. CodeWiKiTap farklı bir kaynağa dayanır: **Google CodeWiki**, her public GitHub deposu için Gemini'nin sentezlediği, kod tabanına özel ve oldukça detaylı bir dokümantasyondur — sadece API referansı değil, mimari diyagramlar, modüller arası ilişkiler, veri akışları, dosya seviyesinde açıklamalar dahil. Üstelik bu içerik her PR birleşmesinde yeniden üretilir; yani eski sürüm sapması olmaz.

Pratik farklar:

- **Bağlam derinliği:** API parametrelerinin ötesinde mimari diyagramlar ve modül-içi açıklamalar.
- **Proje farkındalığı:** context7 isteğe bağlı çalışır (siz veya ajan kütüphane adını söyler), CodeWiKiTap oturum başında manifesti zaten taramıştır.
- **Bilgi grafı:** CodeWiki sayfalarından çıkarılan tipli ilişkiler üzerinde dolaşmanıza imkân verir (aşağıda detayı var).
- **Kapsam:** CodeWiki yalnız public GitHub depolarını destekler — context7'nin geniş kütüphane listesi farklı bir kullanım senaryosunu karşılar. İki araç birbirini dışlamaz, yan yana çalışabilir.

### Doküman üzerinde bilgi grafı

CodeWiKiTap, CodeWiki dokümantasyonunu indekslerken aynı geçişte **tipli bir bilgi grafı** çıkarır. Beş kayıtlı kenar türü vardır:

- `code_ref` — bir doküman sayfası belirli bir kaynak dosyaya referans verir
- `diagram_edge` — bir Mermaid/mimari diyagram içindeki kenar
- `diagram_member` — bir node bir diyagram kümesine aittir
- `section_link` — aynı sayfanın bölümleri arasındaki çapa bağlantısı
- `cross_repo_ref` — bir doküman başka bir yukarı-akış deposuna atıf yapar

Buna sorgu-zamanı türetilen `dep_link` (proje taraması + wiki indeks durumu) eklenir. `find_neighbors` aracı ile ajan şu tür sorgular yapabilir:

- "Hangi dokümanlar `src/auth/login.ts` dosyasına atıf yapıyor?"
- "Auth diyagramındaki `AuthRouter` node'una hangi bileşenler bağlı?"
- "Bu deponun dokümanları `vercel/next.js`'i nerede alıntılıyor?"

Diyagramları okuyan / sembolleri tarayan ayrıca bir bağımsız modele ihtiyaç yoktur — graf, parça indeksleme adımıyla birlikte üretildiği için ekstra model indirme veya disk maliyeti yaratmaz.

---

## Pratikte nasıl çalışır — bir örnek

Diyelim ki Next.js 14 App Router projenizde bir cache sorunu var: `revalidatePath` çağrınız bir mutation sonrası beklediğiniz gibi temizlemiyor. Ajana soruyorsunuz:

> "Bu component'te `revalidatePath` çağrım neden cache'lenmiş fetch'i yenilemiyor?"

**CodeWiKiTap olmadan:** Ajan büyük ihtimalle eğitim verisinden hatırladığı genel kalıplara dayanarak birkaç olasılık sıralar — "cache key uyuşmuyor olabilir", "tag'leme eksik olabilir" gibi. Kesin bilgi alabilmeniz için Next.js'in resmi dokümantasyonuna kendiniz bakmanız gerekir.

**CodeWiKiTap ile:** Ajan arka planda dört adım uygular.

1. **Proje oryantasyonu.** Oturum başında zaten `list_project_dependencies` çağrılmıştır. Ajan, `next` paketinin `vercel/next.js` deposuna eşleştiğini ve 18 sayfa CodeWiki dokümantasyonu bulunduğunu bilmektedir.

2. **Hibrit arama.** `find_chunks` sorgusu — `"revalidatePath cached fetch server component"` — `vercel/next.js` kapsamına alınır. Sorgu hem BM25 (anahtar-kelime) hem yoğun vektör (anlamsal) arama yapar, ikisini Reciprocal Rank Fusion ile birleştirir, üstüne cross-encoder ile yeniden sıralar. Geri dönen parçalar `vectorScore`, `bm25Score`, `rrfScore` ve `rerankScore` alanlarıyla birlikte gelir; sıralamayı denetlemek mümkündür.

3. **Hedefli ayrıntı.** Üst sonuç App Router → Caching → On-demand revalidation bölümüdür. Ajan `get_page` ile bu alt-bölümün tam Markdown içeriğini çeker — diyagramlar, kod örnekleri ve `revalidatePath(path, type)` imzasıyla birlikte.

4. **Bilgi grafı dolaşımı (opsiyonel).** Mimari ilişkileri görmek için `find_neighbors` çağrısı yapılabilir: `RouteCache` node'unun komşuları — `FullRouteCache`, `DataCache`, `RouterCache`, `RequestMemoization` — her biri kendi kaynak alıntısıyla döner.

Sonuç olarak ajanın yanıtı şu hâle gelir:

> "Next.js dokümantasyonuna göre ([commit `a1b2c3d`'ye sabitlenmiş kaynak](https://codewiki.google/...)), `revalidatePath(path)` tek başına yalnız **route segment** cache'ini geçersiz kılar. `force-cache` ile alınan fetch sonucu **Data Cache**'te tutulur ve bağımsız olarak anahtarlanır. Her iki cache'i de temizlemek için `revalidatePath(path, 'page')` kullanılmalı; alternatif olarak fetch'i bir tag ile etiketleyip `revalidateTag(tag)` çağrılabilir."

Tahmine değil resmi dokümana dayalı, alıntı içeren, doğrulanabilir bir yanıt — kullanıcı arayüzünde kaynak linkine tıklayarak içeriği denetleyebilirsiniz.

---

## Kurulum

Tek satır:

```bash
npx codewikitap
```

İlk çalıştırmada ~30 MB'lık Playwright `chromium-headless-shell` indirilir (CodeWiki Angular SPA olduğu için basit HTTP isteği boş sayfa döndürür; tarayıcı kullanılması gerekir). Bir kez indikten sonra başlangıç anlıktır.

`codewikitap` doğrudan çağrılmaz; kodlama ajanı onu bir alt-süreç olarak başlatır. Aşağıda kullandığınız araca göre ekleyeceğiniz 4 satırlık yapılandırma var.

### Claude Code

`~/.claude/mcp.json` (veya proje kökünde `.mcp.json`):

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

Veya Claude eklenti pazarı üzerinden (tek komut):

```text
/plugin marketplace add burakarslan0110/codewikitap
/plugin install codewikitap@burakarslan0110-codewikitap
```

### Cursor

`~/.cursor/mcp.json` (veya `<proje>/.cursor/mcp.json`) — Claude Code ile aynı JSON şekli.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.codewikitap]
command = "npx"
args = ["-y", "codewikitap"]
```

### Gemini CLI

`~/.gemini/settings.json` içinde `mcpServers` altına — Claude Code şekli birebir aynı.

### Qwen Code, opencode, Antigravity

Hepsi `mcpServers` (veya `mcp`) JSON nesnesi alır — Cursor / Claude Code şeklinin aynısı. Aracın yapılandırma dosyasına yapıştır, yeniden başlat, hazır.

---

## Ajanın eline ne geçer — 7 araç

Bu araçları doğrudan çağırmazsınız; ajan çağırır. Yine de hangi yetenekleri eklediğini bilmek faydalı olur:

| Araç | Ne için kullanılır |
|---|---|
| `list_project_dependencies` | Oturum başında bir kez çağrılır. "Bu projede hangi bağımlılıklar var ve hangilerinde CodeWiki dokümanı bulunuyor?" — tüm seansın temeli. |
| `resolve_repo` | "react" gibi belirsiz bir adı `facebook/react` formuna çevirir. Owner/repo zaten biliniyorsa atlanır. |
| `list_pages` | Bir kütüphanenin içindekiler sayfası. Hangi konular ve başlıklar var? |
| `get_page` | Bir sayfayı veya alt-bölümü tam Markdown olarak getirir; diyagramları, kod örneklerini ve alıntı altbilgisini birlikte. |
| `find_chunks` | Hibrit arama: BM25 + vektör + Reciprocal Rank Fusion + cross-encoder yeniden-sıralama. Sonuç olarak en alakalı paragrafları beş ayrı puanla denetlenebilir biçimde döndürür. |
| `find_neighbors` | Bilgi grafı dolaşımı. "Bu dosyaya hangi dokümanlar referans verir?", "Bu diyagram node'una ne bağlı?", "Bu dokümanda alıntılanan başka depo nedir?" |
| `request_indexing` | Önceden ısıtma. İlerleyen sorgular için bir depoyu önceden indeksler, ilk sorgu gecikmesini ortadan kaldırır. |

Bu yedi isim **kilitli**. Hiçbir eklenti veya hook gizliden 8. bir araç ekleyemez — sunucu kod düzeyinde reddeder.

---

## Hangi proje türleri destekleniyor

CodeWiKiTap, projeyi "tanımak" için manifest dosyanızı okur. 11 ekosistemde tam destek var, çalışma alanı (workspace) yapılarıyla birlikte:

- **JavaScript / TypeScript:** `package.json` + npm/pnpm/yarn `workspaces`, `pnpm-workspace.yaml`
- **Python:** `requirements.txt`, `pyproject.toml` (PEP 621 + Poetry)
- **Go:** `go.mod`, `go.work` (workspace farkındalıklı)
- **Rust:** `Cargo.toml` + `[workspace] members` (literal ve glob)
- **PHP:** `composer.json` (platform paketleri otomatik filtrelenir)
- **Java:** `pom.xml` — tam özellik çözümlemesi + BOM içe-aktarımları (yinelemeli, döngü-güvenli) + `<parent>` POM + aggregator-pom `<modules>` gezinmesi
- **Gradle:** `gradle/libs.versions.toml` Version Catalogs + `settings.gradle(.kts)` alt-proje keşfi + alt-proje başına `build.gradle(.kts)` parsing
- **Ruby:** `Gemfile.lock` (tercihli) + `Gemfile` regex yedeği
- **.NET:** `*.csproj` + `Directory.Packages.props` (CPM) + `*.sln` çözümü-güdümlü keşif

"react" demeniz yeterlidir; resolver `facebook/react` adresine kendiliğinden eşler. Maven Central, RubyGems, NuGet, crates.io, Packagist, npm registry hepsi entegredir.

---

## Beklenti yönetimi — bu nasıl bir araç değil?

- **Bir AI modeli değildir.** Yapay zeka modeli barındırmaz; ajanın hâlihazırda kullandığı AI'nın bağlam kalitesini iyileştirir.
- **Doküman üreticisi değildir.** İçeriği kendi üretmez; Google CodeWiki'nin Gemini ile ürettiği dokümanı getirir.
- **Bulut servisi değildir.** Veri dışarı çıkmaz. Çağrılar yerel makinede gerçekleşir, cache yereldir (`~/.cache/...`), telemetri yoktur.
- **Yalnızca public depolar.** Google CodeWiki şu an yalnızca public GitHub depolarını destekler; private depo erişimi Gemini CLI extension'ı olarak waitlist'tedir.

---

## Yapılandırma

Varsayılan ayarlar çoğu durumda yeterlidir. İnce ayar gerekirse en sık başvurulan değişkenler şunlardır:

| Değişken | Varsayılan | İşlevi |
|---|---|---|
| `LOG_LEVEL` | `info` | Stderr log detay seviyesi (`debug` / `info` / `warn` / `error`). |
| `CODEWIKI_INCLUDE_DEV_DEPS` | kapalı | Açıldığında `devDependencies` de taranır (test araçlarının dokümantasyonu gerektiğinde). |
| `CODEWIKI_DISABLE_WATCH` | kapalı | Açıldığında `package.json` değişiklikleri izlenmez (CI/CD ortamlarında faydalı). |
| `CODEWIKI_DISABLE_KG` | kapalı | Açıldığında bilgi grafı oluşturulmaz; `find_neighbors` devre dışı kalır. |
| `CODEWIKI_DISABLE_PREWARM` | kapalı | Açıldığında başlangıçta otomatik indeksleme yapılmaz. |
| `CODEWIKI_FORCE_NO_BM25` | kapalı | Açıldığında `find_chunks` yalnız vektör modunda çalışır (BM25 dalı atlanır). |
| `CODEWIKI_RERANK_TOP_N` | `50` | Yeniden-sıralayıcıya gönderilen aday parça sayısı. |

Tam liste için: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Bilinmesi gerekenler

- **AI üretimi içerik.** Google CodeWiki sayfaları Gemini tarafından üretilir; genelde doğru olsa da %100 garanti değildir. CodeWiKiTap, her yanıt parçasına alıntı altbilgisini zorla ekler — kaynak link'inin doğrulama için kullanılması beklenir.
- **Hız limiti.** CodeWiki bot tespiti olan bir Angular SPA olduğu için CodeWiKiTap kendi tarafında 4 saniyede 1 sayfa yükleme limiti uygular. Tipik kullanım senaryolarında bu hissedilmez; çok sayıda farklı depoyu eş zamanlı taramak istenirse gecikme görülebilir.
- **Kurulum boyutu.** İlk çalıştırma ~150 MB Chromium indirir (Playwright headless), ilk `find_chunks` çağrısı ~50 MB ONNX modeli indirir (gömme + yeniden-sıralama). Bu indirmeler tek seferliktir, kalıcı önbelleğe alınır.
- **Kapsam sınırı.** Yalnızca doğrudan bağımlılıklar taranır. `peerDependencies` ve transitive bağımlılıklar şu an dışlanır; npm `optionalDependencies` varsayılan olarak dahildir.

---

## Yol Haritası

- **v0.3** (bu sürüm) — İlk genel npm sürümü. İki dilli dokümantasyon, eklenti pazarı, CI/CD, marka kimliği.
- **v0.4** — `--version` / `--help` argv bayrak işleyicileri; daha geniş smoke-test kapsamı; macOS CI matrisi.
- **v0.5+** — Hosted uzaktan MCP taşıma (Cloudflare Workers + Browser Rendering) — yerel kurulum istemeyenler için.

---

## Katkıda Bulunma

[CONTRIBUTING.md](CONTRIBUTING.md) — pnpm araç zinciri, test akışı, sürüm süreci.

Güvenlik açıkları: [SECURITY.md](SECURITY.md). Genel issue olarak açma.

---

## Lisans

[MIT](LICENSE) — © 2026 Burak Arslan.

CodeWiKiTap Google ile bağlantılı değildir. "CodeWiki" adı, betimleyici şekilde — veri kaynağı olarak — referans edilir.
