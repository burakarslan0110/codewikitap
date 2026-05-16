# What is CodeWikiTap?

## Google CodeWiki — the upstream source

[**Google CodeWiki**](https://codewiki.google) is a research project from Google that generates a deep, structured technical wiki for every public GitHub repository. It runs entirely on Gemini: every page is synthesized from the source tree, regenerated on each pull-request merge, and pinned to a specific commit SHA — so the documentation never drifts away from the code.

A CodeWiki page is more than an API table:

- **Module-level explanations** that read like a senior engineer onboarding you — what the module does, how it fits, what it expects.
- **Architecture diagrams** (Mermaid) for the larger systems, regenerated from the actual call graph.
- **Cross-references** between source files, types, and other repositories.
- **A citation footer** on every page that points at the exact commit + file the explanation was derived from.

Two practical caveats matter:

1. **Public GitHub only.** Private repos are gated behind a waitlisted Gemini extension; CodeWikiTap does not work around that.
2. **AI-generated content.** Gemini is good but not infallible. Every page links back to the source — verify when correctness matters.

::: warning Not affiliated with Google
CodeWikiTap is an independent open-source project. The "CodeWiki" name is referenced descriptively as the upstream data source. Nothing here ships with, or is endorsed by, Google.
:::

## CodeWikiTap — the local MCP server

CodeWikiTap is a small Node/TypeScript program that runs locally on your machine as a **Model Context Protocol (MCP) server**. Your coding agent (Claude Code, Cursor, Codex CLI, Gemini CLI, Qwen Code, opencode, Antigravity, Windsurf) talks to it over stdio, and it exposes a locked surface of **five tools** that let the agent pull CodeWiki content into its context window on demand.

The shortest mental model:

```
       ┌────────────────────────┐
       │   Your coding agent    │
       │   asks a question      │
       └────────────┬───────────┘
                    │  stdio (JSON-RPC)
                    ▼
       ┌────────────────────────┐
       │      CodeWikiTap       │   ← local, no API keys, no telemetry
       │   (this MCP server)    │
       └────────────┬───────────┘
                    │  hybrid retrieval over indexed CodeWiki pages
                    ▼
       ┌────────────────────────┐
       │   Google CodeWiki      │   ← upstream, public repos only
       │   (cached, SHA-pinned) │
       └────────────────────────┘
```

What it actually adds on top of "just fetch CodeWiki":

- **Project awareness.** At startup it scans your manifest (`package.json`, `pom.xml`, `Cargo.toml`, `go.mod`, …) and resolves your direct dependencies to GitHub repos, then probes CodeWiki for coverage. The agent knows which libraries have docs **before** the first question.
- **Hybrid retrieval.** BM25 keyword search + dense vector search → Reciprocal Rank Fusion → cross-encoder rerank. Five scores per chunk so the ranking is auditable.
- **Knowledge graph.** While indexing, five typed edge kinds are extracted in the same SQLite transaction. The agent can ask "which docs reference `src/auth.ts`?" or "what is connected to the `AuthRouter` diagram node?".
- **Citation enforcement.** Every chunk and every page response carries a byte-equal footer with the source URL and pinned commit SHA. The footer is asserted in tests; there is no way to silence it.
- **Locked tool surface.** The server refuses to register a sixth tool. Names matching `/(search|ask|query|generate|index|write)/i` are rejected at the code level — no plugin or hook can quietly extend the API.

## Why RAG-powered (and not just dump the docs)?

A typical CodeWiki page is dense — usually 2,000 to 4,000 tokens. A real library has many of them. Next.js, for example, sits on **18 pages** at the time of writing; React has dozens. Stuff them all into the agent's context and you blow the budget on documentation before you've even seen the question.

```
NAIVE (no RAG) — "give the agent everything"

   ┌─────────────────────────────────────────────────────────┐
   │ vercel/next.js  CodeWiki = 18 pages × ~3,000 tok ≈ 54k  │
   │ facebook/react  CodeWiki = 40+ pages × ~3,000 tok ≈ 120k│
   │ prisma/prisma   CodeWiki = 25+ pages × ~3,000 tok ≈ 75k │
   │                            ...                          │
   └─────────────────────────────────────────────────────────┘
                              │
                              ▼  stuffed into the prompt
              ✗ context blown · ✗ cost spike · ✗ relevance drowns


RAG (what CodeWikiTap does)

   54k tokens of Next.js docs
          │
          ▼  chunked at heading boundaries (canonical tree)
   ~200 chunks of ~250 tokens each
          │
          ▼  indexed once into cache.db
   BM25 (FTS5) ┐
               ├──► RRF fusion ──► cross-encoder rerank
   dense vec  ─┘                              │
                                              ▼
                          top-K chunks (~5 × ~250 tok ≈ 1.2k tok)
                                              │
                                              ▼
                          delivered to the agent with citations
              ✓ focused · ✓ cheap · ✓ auditable · ✓ verifiable
```

### Why hybrid (BM25 + vectors), not just one?

- BM25 alone misses paraphrases — "data fetching" doesn't match "remote data loading".
- Vectors alone miss exact symbols — `useEffect` or `revalidateTag` need keyword precision.
- Fused via Reciprocal Rank Fusion (RRF, k=60), neither failure mode dominates. The cross-encoder rerank then re-orders the top candidates with full attention over query + chunk, fixing the residual ranking errors of both methods.

The result is a context payload roughly **40–80× smaller** than naive injection, with measurably higher recall (regression-locked floors in `tests/eval/`: `NDCG@8 ≥ 0.55`, `Recall@8 ≥ 0.80`).

## What this is *not*

- **Not an AI model.** No model is bundled here. CodeWikiTap improves the *context quality* delivered to the AI your agent already uses.
- **Not a documentation generator.** Content is fetched from Google CodeWiki, which Gemini produces.
- **Not a cloud service.** Nothing leaves your machine. Local SQLite cache, local ONNX inference, zero telemetry.
- **Not affiliated with Google.** Independent open-source project; the upstream "CodeWiki" name is referenced descriptively as the data source.
- **Not for private repos.** Google CodeWiki currently covers only public GitHub repos; private-repo access is a waitlisted Gemini CLI extension.

---

Next: [Installation](/guide/installation) — how to wire CodeWikiTap into your agent.
