# Contributing to CodeWiKiTap

Thanks for your interest in CodeWiKiTap! This guide covers the dev workflow, tools, and release process.

## Quick Links

- [README](README.md) (English) / [README.tr.md](README.tr.md) (Turkish)
- [LICENSE](LICENSE) — MIT
- [SECURITY.md](SECURITY.md) — vulnerability disclosure
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [Project rules](.claude/rules/) — invariants AI agents and human contributors must respect

## Getting Started

```bash
# 1. Clone
git clone https://github.com/burakarslan0110/codewikitap.git
cd codewikitap

# 2. First-time install (approves native builds for better-sqlite3 + sqlite-vec)
pnpm setup-deps

# 3. Subsequent installs (binaries are cached after step 2)
pnpm install

# 4. Pre-install Playwright headless shell (one-time, ~30 MB)
npx playwright install --only-shell chromium
```

### Toolchain

- **Node.js 20.x** (pinned via `engines.node` and `.nvmrc`). The codebase uses ESM (`"type": "module"`) with NodeNext resolution, so TypeScript imports carry `.js` extensions.
- **pnpm 10.33.4** (pinned via `packageManager`). **⛔ Use pnpm only.** Never `npm install`, `yarn`, or `bun` — they'll regenerate the lock file incorrectly. pnpm 11.x adds an interactive approval gate on top of `onlyBuiltDependencies` that conflicts with our `dangerouslyAllowAllBuilds` flag — stay on pnpm 10.x.
- **TypeScript 5.7+, strict mode.** `noUnusedLocals` and `noUnusedParameters` are enabled.

## Commands

| Task | Command |
|---|---|
| Install (first time, native builds) | `pnpm setup-deps` |
| Install (subsequent) | `pnpm install` |
| Dev (watch via tsx) | `pnpm dev` |
| Build to `dist/` | `pnpm build` |
| Lint | `pnpm lint` |
| Unit tests | `pnpm test` |
| Integration tests (real Playwright) | `pnpm run test:integration` |
| All tests (unit + integration) | `pnpm run test:all` |
| Audit harness (regression-strict thresholds) | `pnpm run audit` |
| Refresh CodeWiki DOM fixtures | `pnpm capture-fixtures` |
| Eval harness (recall@k + NDCG@8) | `pnpm run eval` |
| Pre-publish smoke test | `pnpm verify-publish` |

Single test file: `node ./node_modules/vitest/vitest.mjs run tests/unit/<file>.test.ts`
Single test by name: append `-t "<pattern>"`.

## Development Workflow

Non-trivial changes follow a plan → implement → verify cycle:

1. **Plan first.** Sketch the change in a short design note: goals, the files you will touch, the new public surface, and how you will verify. Get it reviewed before writing production code.
2. **TDD for behavior changes.** Write a failing test for the new behavior, then the minimal implementation that makes it pass, then refactor. Skip the failing-test step only for documentation, configuration, or formatting-only changes.
3. **Verify the running program.** Tests passing is not enough — actually run the MCP server (e.g., via `pnpm dev`) and exercise the changed tool against a real CodeWiki page before opening a PR.
4. **Update the docs in the same change.** README, CHANGELOG, and any tool descriptions in `src/tools/*.ts` move in lockstep with the behavior. Stale docs are a bug.

### Code Style

- Self-documenting code; avoid comments that restate what the code says.
- Explicit return types on all exported functions.
- No `any` — use `unknown`, a specific type, or a generic.
- kebab-case for filenames.
- Import order: `node:` built-ins → external → internal → relative.
- `.js` suffix on internal imports (NodeNext resolution).

### Testing Posture

Parsimonious. New public production classes get **at most 1 unit test class + 1 functional test class** (the latter only when behavior can't be exercised through unit tests). Tests assert observable behavior, not internal structure (Uncle Bob's *Test Contravariance*). See `.claude/rules/testing-project.md` if present, or the global `testing.md` rule.

The full suite must pass before any commit lands:

```bash
pnpm lint
pnpm run test:all
pnpm run audit
```

## Maintainer Release Process

Releases are automated via `.github/workflows/release.yml`, triggered by pushing a `v*` git tag.

### Prerequisites (one-time)

1. **NPM_TOKEN secret.** On `github.com/burakarslan0110/codewikitap` → Settings → Secrets and variables → Actions → New repository secret: `Name: NPM_TOKEN`, `Value: <your npm publish token>`. Generate the token at `https://www.npmjs.com/settings/<your-username>/tokens` with `Automation` type.
2. **npm login locally** (for manual fallback): `npm login`.

### Release Flow

```bash
# 1. Bump version in package.json (e.g., 0.3.0 → 0.3.1)
# 2. Update CHANGELOG.md with the new version entry
# 3. Commit + tag
git commit -am "release: v0.3.1"
git tag v0.3.1
git push origin main --tags
```

The release workflow (`release.yml`) will:

1. Check out the tag
2. Install with pnpm 10.33.4
3. Run `pnpm build`
4. Run `pnpm publish --no-git-checks --access public`
5. Create a GitHub Release with notes extracted from CHANGELOG.md

### Manual Fallback (if CI fails)

```bash
pnpm install
pnpm build
pnpm verify-publish        # local smoke test
npm publish --access public
```

Don't forget to manually create the GitHub Release from the tag if the workflow didn't.

### Plugin Marketplace Refresh

After publishing to npm, users with the self-hosted plugin marketplace installed run `/plugin marketplace update burakarslan0110-codewikitap` to pick up the new version. The marketplace.json `source: npm` form auto-tracks npm publishes — no manual marketplace.json bump needed.

For the official `anthropics/claude-plugins-official` marketplace, the update flow is the same — the marketplace.json `npm` source picks up the new published version automatically. Maintainers handle official marketplace submission and re-submission against Anthropic's submission form (`https://claude.ai/settings/plugins/submit`, `https://platform.claude.com/plugins/submit`, or `https://clau.de/plugin-directory-submission`).

### Recommended GitHub Topics

Gemini CLI and Codex CLI do not have first-party plugin marketplaces, so discoverability lives in npm keywords (see `package.json.keywords`) and GitHub repo topics. Keep the following set in the repo settings (Settings → About → Topics):

- `mcp-server` — discoverable by anyone browsing MCP servers
- `model-context-protocol` — protocol-level tag
- `claude-code`, `cursor`, `codex-cli`, `gemini-cli` — per-CLI tags that mirror the keywords list
- `google-codewiki` — data-source tag for users searching by upstream

Updating this list is a maintainer action (web UI only — GitHub does not version-control topics in repo files). Sync any keyword change to `package.json.keywords` here as well so both surfaces stay aligned.

## Pull Requests

- Branch from `main`.
- One logical change per PR.
- Include a short design note for non-trivial changes (link to the plan doc or paste the summary into the PR description).
- CI must be green (lint + unit + integration + audit) before review.
- Squash-merge into `main`; commit message should reference the plan.

## Issues

- Bug reports — please include: reproduction steps, expected vs actual behavior, agent (Claude Code / Cursor / Codex / etc.), CodeWiKiTap version, Node version, OS.
- Feature requests — keep them concrete. "Add support for X" is better than "make it better".
- Use [SECURITY.md](SECURITY.md) for vulnerability reports — do NOT file them as public issues.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
