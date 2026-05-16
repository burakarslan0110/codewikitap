# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

CodeWiKiTap is in pre-1.0. The `0.3.x` line is the only supported track. Earlier internal versions (`0.1.x`, `0.2.x`) were never published to npm and are not security-supported.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email security reports to **burakarslan0110@gmail.com** with subject line `[codewikitap security] <short description>`.

Please include:

- Affected version(s) (`codewikitap@x.y.z`)
- A short description of the vulnerability
- Steps to reproduce, or a proof-of-concept if available
- The impact you observed
- Whether you intend to publish details, and on what timeline

**Response timeline:**

- Acknowledgement within 7 business days.
- Initial assessment within 14 business days.
- Coordinated disclosure within 90 days, unless extended by mutual agreement (e.g., for issues that require coordination with upstream Google CodeWiki or with `@modelcontextprotocol/sdk`).

If you do not receive a response within 7 business days, please open a *non-detailed* GitHub issue (without exploit details) asking for a status update — the public ping is to confirm the email reached me, not to disclose the vulnerability.

## Zero-Telemetry Statement

**CodeWiKiTap transmits no user code, queries, or environment data to any third party.** Specifically:

- No analytics, crash reporting, or telemetry SDKs are bundled.
- The only outbound traffic is HTTPS to `codewiki.google` (the upstream documentation source the MCP server reads from) and, on first run, to the npm registry for Playwright's `chromium-headless-shell` download (one-time, cached locally thereafter).
- No `localStorage`, `cookies`, or user identifiers cross the network. The MCP server runs entirely as a stdio child process of the user's coding agent — it has no internet-facing surface.
- Caches and indexes live exclusively under `$XDG_CACHE_HOME` / `$XDG_STATE_HOME` (or the platform equivalent) on the user's local machine.

If you discover any traffic that contradicts this statement, please report it as a security vulnerability — that would be a serious bug.

## Operational Caveats

These are operational characteristics, not vulnerabilities, but they are worth knowing if you are evaluating the package for restricted environments:

- **Playwright headless browser.** CodeWiKiTap drives `chromium-headless-shell` to load `codewiki.google` pages (server-side Angular SPA — direct HTTP `curl` returns an empty shell). Users on networks that restrict outbound HTTPS to `*.google.com` may need to allowlist `codewiki.google`. The browser instance is sandboxed by Playwright; no user data crosses the boundary.
- **CodeWiki upstream rate limits.** The MCP server self-throttles to 1 page-load per 4 seconds per origin (`config.ts:RATE_LIMIT_MS`). Upstream Google may apply additional limits server-side. Status code `rate_limited` in tool responses indicates back-off is needed; the MCP does not retry automatically.
- **Native modules.** `better-sqlite3` (optional dependency) and `sqlite-vec` (runtime dependency) are native modules compiled at install time. Their upstream security advisories are inherited; we pin to current minor versions and watch for CVE updates. On install, pnpm requires explicit approval via the `dangerouslyAllowAllBuilds` flag (see `pnpm setup-deps` script).
- **Cache file location.** The SQLite cache (`cache.db`) and rotating log file (`server.log`) live under `$XDG_STATE_HOME/codewikitap/` (typically `~/.local/state/codewikitap/` on Linux, `~/Library/Application Support/codewikitap/` on macOS). The cache contains the text content of CodeWiki pages your project's dependencies have queried — review file permissions if running on a multi-user system.
- **MCP protocol surface.** CodeWiKiTap registers 4 read-only tools plus 1 non-read-only tool (`get_page`, whose `prepareOnly: true` path performs HTTP fetch + sqlite write). The tool surface is locked at runtime (regex `/(search|ask|query|generate|index|write)/i` with no whitelist — every match-token is rejected); plugins or hooks cannot extend it. See [`.claude/rules/codewikitap-mcp-tools.md`](.claude/rules/codewikitap-mcp-tools.md) for the locked-surface rationale.

## See Also

- [LICENSE](LICENSE) — MIT, no warranty, as documented above.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to develop locally, including pnpm-only toolchain.
- [README.md § Configuration](README.md) — environment variables, including security-relevant toggles (`CODEWIKI_DISABLE_KG`, `CODEWIKI_DISABLE_WATCH`, `CODEWIKI_DISABLE_PREWARM`).
