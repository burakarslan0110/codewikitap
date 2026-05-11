/**
 * Eval harness — measures recall@k + citation correctness for `find_chunks`
 * AND graph correctness for `find_neighbors` against fixture-backed pages.
 *
 * Loads the committed gold set at `tests/eval/gold.json`, runs each query
 * against fixture-backed pages (using the same `client.fetchPage` stubbing
 * pattern as the integration tests), and reports metrics. Exits non-zero
 * when any threshold is missed.
 *
 * Run via `pnpm run eval`. Live-fixture queries are gracefully skipped
 * when the corresponding HTML files are absent (capture them with
 * `pnpm capture-fixtures` first if you want the full eval).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { Cache } from '../src/services/cache.js';
import { CodeWikiClient } from '../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../src/adapters/playwright_driver.js';
import { Embedder } from '../src/adapters/embedder.js';
import { Reranker, ScorerImpl } from '../src/adapters/reranker.js';
import { VectorStore } from '../src/services/vector_store.js';
import { GraphStore } from '../src/services/graph_store.js';
import { Indexer } from '../src/services/indexer.js';
import { Retriever } from '../src/services/retriever.js';
import { GraphQuery, GraphQueryResult } from '../src/services/graph_query.js';
import { extractFromDocument } from '../src/extraction/dom_to_tree.js';
import { CITATION_FOOTER_REGEX } from '../src/extraction/serializer.js';
import type { ExtractionResult } from '../src/extraction/canonical_tree.js';

/**
 * v2.6 dual-baseline eval mocks. Real Xenova/ms-marco model load in the eval
 * script would add ~22MB download on every run; we instead exercise the
 * retriever's rerank wiring with two deterministic scorers:
 *   - vectorOnlyScorer: returns 0 for every candidate, so rerank ordering
 *     collapses to vector ordering (equivalent to RERANK_OFF).
 *   - lexicalOverlapScorer: scores candidates by query-token overlap, an
 *     approximation of cross-encoder lexical-precision boost. Demonstrates
 *     a non-trivial ordering change vs. pure cosine, lets the eval surface
 *     NDCG@k deltas in a deterministic way for CI.
 */
function vectorOnlyScorer(): Reranker {
  const scorer: ScorerImpl = {
    async score(_query: string, candidates: string[]): Promise<number[]> {
      // Return monotonically decreasing scores so the retriever's
      // `sort by rerankScore desc` PRESERVES the input order (which the
      // retriever pre-sorts by vector score). Avoids relying on JS
      // stable-sort behavior with all-equal scores — explicit identity.
      return candidates.map((_, i) => candidates.length - i);
    },
  };
  return new Reranker({ scorerImpl: scorer });
}

function lexicalOverlapScorer(): Reranker {
  const scorer: ScorerImpl = {
    async score(query: string, candidates: string[]): Promise<number[]> {
      const qTokens = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
      return candidates.map((c) => {
        const cLow = c.toLowerCase();
        let hits = 0;
        for (const t of qTokens) {
          if (cLow.includes(t)) hits += 1;
        }
        return hits;
      });
    },
  };
  return new Reranker({ scorerImpl: scorer });
}

/**
 * NDCG@k — discounted cumulative gain normalized by ideal ranking.
 * Binary relevance: a returned slug is relevant if it's in `expected`.
 * Standard formula: DCG = sum_{i=1..k} rel_i / log2(i+1); IDCG = ideal DCG.
 * Returns 1 when expected is empty (vacuously correct).
 */
function ndcgAtK(returned: string[], expected: string[], k: number): number {
  if (expected.length === 0) return 1;
  const expSet = new Set(expected);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, returned.length); i++) {
    if (expSet.has(returned[i])) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  // Ideal: relevant items in top positions, capped at min(expected.length, k).
  const idealRelevant = Math.min(expected.length, k);
  let idcg = 0;
  for (let i = 0; i < idealRelevant; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

interface GoldQuery {
  fixture: string;
  repo: string;
  query: string;
  expectedSlugs: string[];
  skipIfMissing?: boolean;
}

interface KgGoldEntry {
  fixture: string;
  repo: string;
  kind: 'pages_referencing_file' | 'diagram_neighbors' | 'section_links' | 'cross_repo';
  args: Record<string, unknown>;
  expectedNeighbors: Array<{ kind: string; id: string }>;
}

interface KgSemanticEntry {
  fixture: string;
  repo: string;
  kind: 'pages_referencing_file' | 'diagram_neighbors' | 'section_links' | 'cross_repo';
  args: Record<string, unknown>;
  query: string;
  /** Expected neighbor IDs in descending-rank order (top match first). */
  expectedOrder: string[];
}

interface GoldSet {
  synthetic: GoldQuery[];
  live: GoldQuery[];
  kg?: { synthetic: KgGoldEntry[]; synthetic_semantic?: KgSemanticEntry[] };
  thresholds: {
    recallAtK: number;
    citationCorrectness: number;
    k: number;
    kgGraphCorrectness: number;
    kgSemanticOrdering?: number;
    kgSemanticNdcgAt8?: number;
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const GOLD_PATH = path.join(ROOT, 'tests', 'eval', 'gold.json');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'codewiki');

interface QueryResult {
  query: string;
  expected: string[];
  topSlugs: string[];
  hit: boolean;
  citationOk: boolean;
  /** v2.6: NDCG@k for this query under the current baseline. */
  ndcg: number;
}

interface KgQueryResult {
  kind: string;
  args: Record<string, unknown>;
  expectedNeighbors: Array<{ kind: string; id: string }>;
  returnedNeighbors: Array<{ kind: string; id: string }>;
  hit: boolean;
}

interface KgSemanticResult {
  kind: string;
  query: string;
  expectedOrder: string[];
  returnedOrder: string[];
  /**
   * Kendall-tau-like positional score in [0, 1]. For each expected ID at
   * position i, the score gets +1 if it appears at position <= i in the
   * returned list. Average over all expected IDs (>= 0.7 = pass).
   */
  ordering: number;
  /**
   * v2.7.1: NDCG@k for this entry's neighbor-id ranking under the gold's
   * expectedOrder set. Binary relevance via `new Set(expectedOrder)`.
   * Computed via the shared `ndcgAtK` helper used by RAG eval.
   */
  ndcg: number;
}

async function evalQuery(retriever: Retriever, q: GoldQuery, k: number): Promise<QueryResult> {
  const result = await retriever.findChunks(q.query, q.repo, k);
  const topSlugs = result.chunks.map((c) => c.sectionSlug);
  const hit = q.expectedSlugs.every((s) => topSlugs.includes(s));
  const citationOk = result.chunks.every(
    (c) => CITATION_FOOTER_REGEX.test(c.text) && c.citation.sourceUrl.endsWith('#' + c.sectionSlug),
  );
  const ndcg = ndcgAtK(topSlugs, q.expectedSlugs, k);
  return { query: q.query, expected: q.expectedSlugs, topSlugs, hit, citationOk, ndcg };
}

async function evalKgQuery(graphQuery: GraphQuery, e: KgGoldEntry): Promise<KgQueryResult> {
  let result: GraphQueryResult;
  switch (e.kind) {
    case 'pages_referencing_file':
      result = await graphQuery.pagesReferencingFile({
        filePath: String(e.args.file_path),
        githubRepo: e.args.github_repo as string | undefined,
      });
      break;
    case 'diagram_neighbors':
      result = await graphQuery.diagramNeighbors({
        repo: String(e.args.repo),
        sectionSlug: String(e.args.section_slug),
        diagramNodeId: e.args.diagram_node_id as string | undefined,
      });
      break;
    case 'section_links':
      result = await graphQuery.sectionLinks({
        repo: String(e.args.repo),
        sectionSlug: String(e.args.section_slug),
        direction: e.args.direction as 'in' | 'out' | 'both' | undefined,
      });
      break;
    case 'cross_repo':
      result = await graphQuery.crossRepo({
        repo: String(e.args.repo),
        direction: e.args.direction as 'in' | 'out' | 'both' | undefined,
      });
      break;
  }
  const returned = result.neighbors.map((n) => ({ kind: n.kind, id: n.id }));
  const hit = e.expectedNeighbors.every((exp) =>
    returned.some((r) => r.kind === exp.kind && r.id === exp.id),
  );
  return {
    kind: e.kind,
    args: e.args,
    expectedNeighbors: e.expectedNeighbors,
    returnedNeighbors: returned,
    hit,
  };
}

async function evalKgSemantic(graphQuery: GraphQuery, e: KgSemanticEntry, k: number): Promise<KgSemanticResult> {
  let result: GraphQueryResult;
  switch (e.kind) {
    case 'pages_referencing_file':
      result = await graphQuery.pagesReferencingFile({
        filePath: String(e.args.file_path),
        githubRepo: e.args.github_repo as string | undefined,
        query: e.query,
      });
      break;
    case 'diagram_neighbors':
      result = await graphQuery.diagramNeighbors({
        repo: String(e.args.repo),
        sectionSlug: String(e.args.section_slug),
        diagramNodeId: e.args.diagram_node_id as string | undefined,
        query: e.query,
      });
      break;
    case 'section_links':
      result = await graphQuery.sectionLinks({
        repo: String(e.args.repo),
        sectionSlug: String(e.args.section_slug),
        direction: e.args.direction as 'in' | 'out' | 'both' | undefined,
        query: e.query,
      });
      break;
    case 'cross_repo':
      result = await graphQuery.crossRepo({
        repo: String(e.args.repo),
        direction: e.args.direction as 'in' | 'out' | 'both' | undefined,
        query: e.query,
      });
      break;
  }
  const returnedOrder = result.neighbors.map((n) => n.id);
  let scoreSum = 0;
  for (let i = 0; i < e.expectedOrder.length; i++) {
    const expected = e.expectedOrder[i];
    const actualIdx = returnedOrder.indexOf(expected);
    if (actualIdx >= 0 && actualIdx <= i) {
      scoreSum += 1;
    } else if (actualIdx >= 0) {
      // Expected ID present but later than expected — partial credit (0.5).
      scoreSum += 0.5;
    }
  }
  const ordering = e.expectedOrder.length === 0 ? 1 : scoreSum / e.expectedOrder.length;
  const ndcg = ndcgAtK(returnedOrder, e.expectedOrder, k);
  return {
    kind: e.kind,
    query: e.query,
    expectedOrder: e.expectedOrder,
    returnedOrder,
    ordering,
    ndcg,
  };
}

function loadFixture(name: string): string | null {
  const p = path.join(FIXTURE_DIR, name + '.html');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8');
}

async function main(): Promise<number> {
  const gold: GoldSet = JSON.parse(fs.readFileSync(GOLD_PATH, 'utf-8'));
  const queries: GoldQuery[] = [...gold.synthetic];

  for (const q of gold.live) {
    const html = loadFixture(q.fixture);
    if (html) {
      queries.push(q);
    } else {
      process.stderr.write(`Skipping live query "${q.query}" — fixture ${q.fixture}.html absent (run pnpm capture-fixtures)\n`);
    }
  }

  if (queries.length === 0 && (!gold.kg || gold.kg.synthetic.length === 0)) {
    process.stderr.write('No queries to evaluate.\n');
    return 1;
  }

  // One ephemeral cache per repo group. Group queries by (fixture, repo).
  const groups = new Map<string, {
    ragQueries: GoldQuery[];
    kgQueries: KgGoldEntry[];
    kgSemanticQueries: KgSemanticEntry[];
  }>();
  const newGroup = (): { ragQueries: GoldQuery[]; kgQueries: KgGoldEntry[]; kgSemanticQueries: KgSemanticEntry[] } => ({
    ragQueries: [],
    kgQueries: [],
    kgSemanticQueries: [],
  });
  for (const q of queries) {
    const key = `${q.fixture}::${q.repo}`;
    const entry = groups.get(key) ?? newGroup();
    entry.ragQueries.push(q);
    groups.set(key, entry);
  }
  for (const e of gold.kg?.synthetic ?? []) {
    const key = `${e.fixture}::${e.repo}`;
    const entry = groups.get(key) ?? newGroup();
    entry.kgQueries.push(e);
    groups.set(key, entry);
  }
  for (const e of gold.kg?.synthetic_semantic ?? []) {
    const key = `${e.fixture}::${e.repo}`;
    const entry = groups.get(key) ?? newGroup();
    entry.kgSemanticQueries.push(e);
    groups.set(key, entry);
  }

  const tmpDir = fs.mkdtempSync(path.join(ROOT, '.eval-tmp-'));
  /** Vector-only baseline (v2.5-equivalent ranking). */
  const allRagResults: QueryResult[] = [];
  /** v2.6 rerank baseline (lexical-overlap mock cross-encoder). */
  const rerankRagResults: QueryResult[] = [];
  const allKgResults: KgQueryResult[] = [];
  const allKgSemanticResults: KgSemanticResult[] = [];
  try {
    const embedder = await new Embedder({}).encode(['warmup']).then(() => new Embedder({})).catch(() => new Embedder({}));

    for (const [key, group] of groups) {
      const [fixtureName, repo] = key.split('::');
      const html = fixtureName === 'synthetic' ? loadFixture('synthetic') : loadFixture(fixtureName);
      if (!html) {
        process.stderr.write(`No fixture for ${fixtureName} — skipping group ${repo}.\n`);
        continue;
      }
      const dom = new JSDOM(html);
      const extracted: ExtractionResult = extractFromDocument(dom.window.document);

      // v2.6 dual-baseline: one cache per (group, baseline). Both baselines
      // share the same fixture + index; only the retriever's reranker differs.
      // Force pure-JS so synthetic fixtures with small fixed-dim embeddings
      // don't collide with the production vec_chunks float[384] schema.
      process.env.CODEWIKI_FORCE_PUREJS_VECTOR = '1';
      const cache = await Cache.open({ dbPath: path.join(tmpDir, `cache-${fixtureName}.db`) });
      const client = new CodeWikiClient(new PlaywrightDriver(), cache);
      client.fetchPage = async (): Promise<ExtractionResult> => extracted;
      const store = new VectorStore(cache);
      const graphStore = new GraphStore(cache);
      const indexer = new Indexer({ client, embedder, store, graphStore, cache });
      const vectorOnlyRetriever = new Retriever({
        embedder,
        reranker: vectorOnlyScorer(),
        store,
        indexer,
      });
      const rerankRetriever = new Retriever({
        embedder,
        reranker: lexicalOverlapScorer(),
        store,
        indexer,
      });
      const graphQuery = new GraphQuery({ graphStore, vectorStore: store, cache, indexer, embedder });

      // Pre-build the index so per-query latency only measures retrieval.
      await indexer.indexRepo(repo);

      for (const q of group.ragQueries) {
        // Vector-only baseline: passthrough reranker, no ordering change.
        const vRes = await evalQuery(vectorOnlyRetriever, q, gold.thresholds.k);
        // Rerank baseline: lexical-overlap mock cross-encoder.
        const rRes = await evalQuery(rerankRetriever, q, gold.thresholds.k);
        allRagResults.push({
          ...vRes,
          // Tag this entry as the rerank baseline for the dual report below.
          // We push BOTH baselines; report aggregates them separately.
        });
        rerankRagResults.push(rRes);
      }
      for (const e of group.kgQueries) {
        allKgResults.push(await evalKgQuery(graphQuery, e));
      }
      for (const e of group.kgSemanticQueries) {
        allKgSemanticResults.push(await evalKgSemantic(graphQuery, e, gold.thresholds.k));
      }
      cache.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // RAG metrics — v2.6: dual baseline (vector-only vs rerank).
  const ragTotal = allRagResults.length;
  const hits = allRagResults.filter((r) => r.hit).length;
  const citationsOk = allRagResults.filter((r) => r.citationOk).length;
  const recall = ragTotal === 0 ? 1 : hits / ragTotal;
  const citationRate = ragTotal === 0 ? 1 : citationsOk / ragTotal;
  const ndcgMean = ragTotal === 0 ? 1 : allRagResults.reduce((s, r) => s + r.ndcg, 0) / ragTotal;

  const rerankHits = rerankRagResults.filter((r) => r.hit).length;
  const rerankRecall = rerankRagResults.length === 0 ? 1 : rerankHits / rerankRagResults.length;
  const rerankNdcgMean = rerankRagResults.length === 0
    ? 1
    : rerankRagResults.reduce((s, r) => s + r.ndcg, 0) / rerankRagResults.length;

  process.stderr.write('\n=== RAG eval results (vector-only baseline) ===\n');
  for (const r of allRagResults) {
    process.stderr.write(`${r.hit ? 'PASS' : 'FAIL'} ${r.citationOk ? '✓cite' : '✗cite'}  ndcg=${r.ndcg.toFixed(3)}  query="${r.query}"  expected=${JSON.stringify(r.expected)}  top=${JSON.stringify(r.topSlugs.slice(0, 3))}\n`);
  }
  process.stderr.write(`\nvector-only recall@${gold.thresholds.k} = ${recall.toFixed(3)}  (threshold ${gold.thresholds.recallAtK})\n`);
  process.stderr.write(`vector-only NDCG@${gold.thresholds.k} = ${ndcgMean.toFixed(3)}\n`);
  process.stderr.write(`citation correctness = ${citationRate.toFixed(3)}  (threshold ${gold.thresholds.citationCorrectness})\n`);

  if (rerankRagResults.length > 0) {
    process.stderr.write('\n=== RAG eval results (rerank baseline) ===\n');
    for (const r of rerankRagResults) {
      process.stderr.write(`${r.hit ? 'PASS' : 'FAIL'}  ndcg=${r.ndcg.toFixed(3)}  query="${r.query}"  top=${JSON.stringify(r.topSlugs.slice(0, 3))}\n`);
    }
    process.stderr.write(`\nrerank recall@${gold.thresholds.k} = ${rerankRecall.toFixed(3)}\n`);
    process.stderr.write(`rerank NDCG@${gold.thresholds.k} = ${rerankNdcgMean.toFixed(3)}\n`);
    const deltaNdcg = rerankNdcgMean - ndcgMean;
    const deltaRecall = rerankRecall - recall;
    process.stderr.write(`Δrecall = ${deltaRecall >= 0 ? '+' : ''}${deltaRecall.toFixed(3)}\n`);
    process.stderr.write(`ΔNDCG  = ${deltaNdcg >= 0 ? '+' : ''}${deltaNdcg.toFixed(3)}\n`);
  }

  // v2.6 regression check against the committed baseline-v2.5.json snapshot.
  let v25BaselinePass = true;
  const baselinePath = path.join(ROOT, 'tests', 'eval', 'baseline-v2.5.json');
  if (fs.existsSync(baselinePath)) {
    interface Baseline {
      vectorOnlyRecallAt8: number;
      vectorOnlyNdcgAt8: number;
      queryCount: number;
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as Baseline;
    process.stderr.write(`\n=== v2.5 regression check ===\n`);
    process.stderr.write(`baseline recall@${gold.thresholds.k} = ${baseline.vectorOnlyRecallAt8.toFixed(3)}\n`);
    process.stderr.write(`baseline NDCG@${gold.thresholds.k} = ${baseline.vectorOnlyNdcgAt8.toFixed(3)}\n`);
    // Allow 1pp recall slack to absorb gold-set churn.
    const recallTolerance = 0.01;
    if (recall < baseline.vectorOnlyRecallAt8 - recallTolerance) {
      process.stderr.write(`FAIL: vector-only recall regressed > 1pp (${recall.toFixed(3)} < ${baseline.vectorOnlyRecallAt8.toFixed(3)} - ${recallTolerance})\n`);
      v25BaselinePass = false;
    }
  }

  // v2.6 rerank quality threshold: ΔNDCG ≥ -0.02 (2pp tolerance band for
  // small gold-set variance — strict ≥ 0 flakes on benign churn).
  let rerankNdcgPass = true;
  if (rerankRagResults.length > 0) {
    const deltaNdcg = rerankNdcgMean - ndcgMean;
    const ndcgTolerance = -0.02;
    if (deltaNdcg < ndcgTolerance) {
      process.stderr.write(`\nFAIL: rerank ΔNDCG (${deltaNdcg.toFixed(3)}) < tolerance (${ndcgTolerance})\n`);
      rerankNdcgPass = false;
    }
  }

  // KG metrics
  const kgTotal = allKgResults.length;
  const kgHits = allKgResults.filter((r) => r.hit).length;
  const kgCorrectness = kgTotal === 0 ? 1 : kgHits / kgTotal;

  if (kgTotal > 0) {
    process.stderr.write('\n=== KG eval results ===\n');
    for (const r of allKgResults) {
      process.stderr.write(
        `${r.hit ? 'PASS' : 'FAIL'} kind=${r.kind}  expected=${JSON.stringify(r.expectedNeighbors)}  returned=${JSON.stringify(r.returnedNeighbors.slice(0, 4))}\n`,
      );
    }
    process.stderr.write(`\ngraph correctness = ${kgCorrectness.toFixed(3)}  (threshold ${gold.thresholds.kgGraphCorrectness})\n`);
  }

  // KG semantic-rank metrics (v2.5 ordering + v2.7.1 NDCG@k)
  const kgSemTotal = allKgSemanticResults.length;
  const kgSemAvg =
    kgSemTotal === 0 ? 1 : allKgSemanticResults.reduce((s, r) => s + r.ordering, 0) / kgSemTotal;
  const kgSemNdcg =
    kgSemTotal === 0 ? 1 : allKgSemanticResults.reduce((s, r) => s + r.ndcg, 0) / kgSemTotal;
  const kgSemThreshold = gold.thresholds.kgSemanticOrdering ?? 0.7;
  const kgSemNdcgThreshold = gold.thresholds.kgSemanticNdcgAt8 ?? 0.6;

  if (kgSemTotal > 0) {
    process.stderr.write('\n=== KG semantic-rank eval results (v2.5) ===\n');
    for (const r of allKgSemanticResults) {
      process.stderr.write(
        `${r.ordering >= kgSemThreshold ? 'PASS' : 'FAIL'} kind=${r.kind}  query="${r.query}"  ordering=${r.ordering.toFixed(3)}  ndcg=${r.ndcg.toFixed(3)}  expected=${JSON.stringify(r.expectedOrder)}  returned=${JSON.stringify(r.returnedOrder.slice(0, 4))}\n`,
      );
    }
    process.stderr.write(`\nkg semantic ordering = ${kgSemAvg.toFixed(3)}  (threshold ${kgSemThreshold})\n`);
    process.stderr.write(`kg semantic NDCG@${gold.thresholds.k} = ${kgSemNdcg.toFixed(3)}  (threshold ${kgSemNdcgThreshold})\n`);
  }

  // v2.7.1 KG semantic-rank baseline regression check: gate against the
  // committed snapshot in baseline-kg-semantic-v2.5.json. Mirror the v2.5
  // RAG baseline pattern at lines 445-464 — current must satisfy
  // `>= floor - 0.02 tolerance`. Failing this line means an ordering or
  // NDCG regression > 2pp vs. the last accepted-quality run.
  let kgSemBaselinePass = true;
  const kgBaselinePath = path.join(ROOT, 'tests', 'eval', 'baseline-kg-semantic-v2.5.json');
  if (fs.existsSync(kgBaselinePath) && kgSemTotal > 0) {
    interface KgBaseline {
      kgSemanticOrderingFloor: number;
      kgSemanticNdcgFloor: number;
      queryCount: number;
    }
    const kgBaseline = JSON.parse(fs.readFileSync(kgBaselinePath, 'utf-8')) as KgBaseline;
    process.stderr.write(`\n=== v2.7.1 KG semantic-rank regression check ===\n`);
    process.stderr.write(`baseline ordering floor = ${kgBaseline.kgSemanticOrderingFloor.toFixed(3)}\n`);
    process.stderr.write(`baseline NDCG floor = ${kgBaseline.kgSemanticNdcgFloor.toFixed(3)}\n`);
    const tol = 0.02;
    if (kgSemAvg < kgBaseline.kgSemanticOrderingFloor - tol) {
      process.stderr.write(`FAIL: kg ordering regressed > 2pp (${kgSemAvg.toFixed(3)} < ${kgBaseline.kgSemanticOrderingFloor.toFixed(3)} - ${tol})\n`);
      kgSemBaselinePass = false;
    }
    if (kgSemNdcg < kgBaseline.kgSemanticNdcgFloor - tol) {
      process.stderr.write(`FAIL: kg NDCG regressed > 2pp (${kgSemNdcg.toFixed(3)} < ${kgBaseline.kgSemanticNdcgFloor.toFixed(3)} - ${tol})\n`);
      kgSemBaselinePass = false;
    }
  }

  const recallPass = recall >= gold.thresholds.recallAtK;
  const citationPass = citationRate >= gold.thresholds.citationCorrectness;
  const kgPass = kgCorrectness >= gold.thresholds.kgGraphCorrectness;
  const kgSemPass = kgSemAvg >= kgSemThreshold;
  const kgSemNdcgPass = kgSemNdcg >= kgSemNdcgThreshold;
  const allPass = recallPass && citationPass && kgPass && kgSemPass && kgSemNdcgPass && v25BaselinePass && rerankNdcgPass && kgSemBaselinePass;
  process.stderr.write(`\n${allPass ? 'PASS' : 'FAIL'}\n`);
  return allPass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
