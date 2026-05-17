---
layout: home

hero:
  name: CodeWikiTap
  text: Google CodeWiki, in your agent.
  tagline: An unofficial, RAG-powered MCP server that streams Google CodeWiki documentation into your coding agent — chunked, cited, and grounded in the exact commit your dependency is pinned to.
  actions:
    - theme: brand
      text: Get started
      link: /guide/installation
    - theme: alt
      text: What is it?
      link: /guide/concepts
    - theme: alt
      text: GitHub
      link: https://github.com/burakarslan0110/codewikitap-mcp

features:
  - icon: 📚
    title: Project-aware
    details: At startup, scans your manifest (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …), resolves direct dependencies to GitHub repos, and probes CodeWiki for coverage — before the agent's first question.
  - icon: 🔎
    title: Hybrid retrieval
    details: BM25 (FTS5) + dense vectors (sqlite-vec) fused with Reciprocal Rank Fusion, then reranked with a cross-encoder. Five scores per chunk — ranking is auditable, not a black box.
  - icon: 🕸️
    title: Knowledge graph
    details: Five typed edge kinds extracted in the same SQLite transaction — `code_ref`, `diagram_edge`, `diagram_member`, `section_link`, `cross_repo_ref`. Ask "what's connected to this?"
  - icon: 🔗
    title: Citation enforced
    details: Every chunk and every page carries a byte-equal footer with the source URL and pinned commit SHA. Asserted in tests — there's no way to silence it.
  - icon: 🔒
    title: Local-first
    details: SQLite cache, ONNX inference, zero telemetry. No API keys. The only network traffic is to CodeWiki itself.
  - icon: 🧩
    title: 9 agents supported
    details: Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Qwen Code, opencode, Windsurf, Antigravity. One interactive wizard writes the right config block for each.
---

## Quick install

```bash
npx codewikitap install
```

Pick your agent, pick a scope, done. The wizard writes the config atomically with a `.bak` backup.

## Why CodeWikiTap?

A typical CodeWiki page is 2,000–4,000 tokens. A real library has dozens of them — Next.js alone has 18 pages (~54 k tokens), React has 40+. Stuffing it all into the agent's context blows the budget before the first question is answered.

CodeWikiTap delivers focused, citation-bearing chunks (~5 × ~250 tokens ≈ 1.2 k tokens), **40–80× smaller** than naive injection, with measurably higher recall.

::: tip Documentation
This site documents the public surface and the design. Continue with [What is CodeWikiTap?](/guide/concepts) for the conceptual model, or jump straight to [Installation](/guide/installation).
:::

> CodeWikiTap is an independent, **unofficial** project. It is not affiliated with, endorsed by, or sponsored by Google. The "CodeWiki" name is referenced descriptively as the upstream data source.

---

<p align="center"><sub>Developed by <a href="https://github.com/burakarslan0110">Burak Arslan</a></sub></p>
