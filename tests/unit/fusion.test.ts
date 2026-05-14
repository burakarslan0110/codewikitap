/**
 * Unit tests for `src/services/fusion.ts` — Reciprocal Rank Fusion (RRF)
 * and the BM25 query-escape helper.
 */

import { describe, it, expect } from 'vitest';

import { reciprocalRankFusion, escapeBM25Query, FusedResult } from '../../src/services/fusion.js';
import type { QueryResult, BM25QueryResult } from '../../src/services/vector_store.js';

function mk(
  sectionSlug: string,
  ordinal: number,
  score: number,
  repo = 'repo/a',
): QueryResult & BM25QueryResult {
  return {
    repo,
    pageSlug: '__root__',
    sectionSlug,
    ordinal,
    text: `text-${sectionSlug}-${ordinal}`,
    embedding: new Float32Array([1, 0, 0, 0]),
    indexedAt: 1234567890,
    commitSha: 'a'.repeat(40),
    score,
  };
}

function slug(r: FusedResult): string {
  return `${r.chunk.sectionSlug}|${r.chunk.ordinal}`;
}

describe('reciprocalRankFusion', () => {
  it('returns empty when both lists are empty', () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it('vector-only input produces fused list with bm25Rank=null', () => {
    const vector = [mk('s1', 0, 0.9), mk('s2', 0, 0.8)];
    const out = reciprocalRankFusion(vector, []);
    expect(out).toHaveLength(2);
    expect(out[0].vectorRank).toBe(1);
    expect(out[0].bm25Rank).toBeNull();
    expect(out[0].vectorScore).toBe(0.9);
    expect(out[0].bm25Score).toBeNull();
    expect(out[0].rrfScore).toBeCloseTo(1 / 61);
  });

  it('BM25-only input produces fused list with vectorRank=null', () => {
    const bm25 = [mk('s1', 0, 4.2), mk('s2', 0, 3.1)];
    const out = reciprocalRankFusion([], bm25);
    expect(out).toHaveLength(2);
    expect(out[0].vectorRank).toBeNull();
    expect(out[0].bm25Rank).toBe(1);
    expect(out[0].bm25Score).toBe(4.2);
  });

  it('full overlap: candidate present in both lists gets summed contributions', () => {
    const vector = [mk('s1', 0, 0.9), mk('s2', 0, 0.8)];
    const bm25 = [mk('s1', 0, 4.2), mk('s2', 0, 3.1)];
    const out = reciprocalRankFusion(vector, bm25);
    expect(out).toHaveLength(2);
    const s1 = out.find((r) => r.chunk.sectionSlug === 's1')!;
    expect(s1.vectorRank).toBe(1);
    expect(s1.bm25Rank).toBe(1);
    expect(s1.rrfScore).toBeCloseTo(1 / 61 + 1 / 61);
  });

  it('partial overlap: candidate only in vector gets only vector contribution', () => {
    const vector = [mk('s1', 0, 0.9), mk('s2', 0, 0.8), mk('s3', 0, 0.7)];
    const bm25 = [mk('s1', 0, 4.2), mk('s4', 0, 3.0)];
    const out = reciprocalRankFusion(vector, bm25);
    expect(out).toHaveLength(4);
    const slugs = new Set(out.map(slug));
    expect(slugs).toEqual(new Set(['s1|0', 's2|0', 's3|0', 's4|0']));
    const s2 = out.find((r) => r.chunk.sectionSlug === 's2')!;
    expect(s2.vectorRank).toBe(2);
    expect(s2.bm25Rank).toBeNull();
  });

  it('orders by rrfScore desc; both-list candidates outrank single-list candidates', () => {
    const vector = [mk('s1', 0, 0.9), mk('s2', 0, 0.8)];
    const bm25 = [mk('s1', 0, 4.2), mk('s2', 0, 3.1)];
    const out = reciprocalRankFusion(vector, bm25);
    // s1 rank 1+1 = 2/61 ; s2 rank 2+2 = 2/62 ; s1 beats s2.
    expect(out[0].chunk.sectionSlug).toBe('s1');
    expect(out[0].rrfScore).toBeCloseTo(2 / 61);
    expect(out[1].chunk.sectionSlug).toBe('s2');
    expect(out[1].rrfScore).toBeCloseTo(2 / 62);
  });

  it('cap truncates output to specified count', () => {
    const vector = Array.from({ length: 10 }, (_, i) => mk(`s${i}`, 0, 1 - i * 0.05));
    const bm25 = Array.from({ length: 10 }, (_, i) => mk(`s${i}`, 0, 10 - i));
    const out = reciprocalRankFusion(vector, bm25, { cap: 3 });
    expect(out).toHaveLength(3);
  });

  it('tunable k changes contribution scale', () => {
    const vector = [mk('s1', 0, 0.9)];
    const out60 = reciprocalRankFusion(vector, [], { k: 60 });
    const out10 = reciprocalRankFusion(vector, [], { k: 10 });
    expect(out10[0].rrfScore).toBeGreaterThan(out60[0].rrfScore);
    expect(out60[0].rrfScore).toBeCloseTo(1 / 61);
    expect(out10[0].rrfScore).toBeCloseTo(1 / 11);
  });

  it('deduplicates on (repo, pageSlug, sectionSlug, ordinal) composite key', () => {
    const vector = [mk('s1', 0, 0.9, 'repo/a'), mk('s1', 0, 0.5, 'repo/b')]; // different repo
    const bm25 = [mk('s1', 0, 4.2, 'repo/a')];
    const out = reciprocalRankFusion(vector, bm25);
    expect(out).toHaveLength(2); // repo/a (merged) + repo/b (vector-only)
    const a = out.find((r) => r.chunk.repo === 'repo/a')!;
    expect(a.vectorRank).toBe(1);
    expect(a.bm25Rank).toBe(1);
  });
});

describe('escapeBM25Query', () => {
  it('wraps single tokens in double-quotes and OR-joins multi-token queries', () => {
    expect(escapeBM25Query('hook')).toBe('"hook"');
    expect(escapeBM25Query('auth setup')).toBe('"auth" OR "setup"');
  });

  it('strips FTS5 grammar characters within tokens', () => {
    // The escape splits on whitespace; non-alphanumeric chars are stripped
    // from each token (no internal split), so 'fts5(text)' collapses.
    expect(escapeBM25Query('*foo*')).toBe('"foo"');
    expect(escapeBM25Query('fts5(text)')).toBe('"fts5text"');
    expect(escapeBM25Query('a:b')).toBe('"ab"');
    expect(escapeBM25Query('"quoted"')).toBe('"quoted"');
    // Surviving tokens are OR-joined.
    expect(escapeBM25Query('foo (bar) baz')).toBe('"foo" OR "bar" OR "baz"');
  });

  it('returns empty string when no tokens survive', () => {
    expect(escapeBM25Query('!@#$%')).toBe('');
    expect(escapeBM25Query('   ')).toBe('');
    expect(escapeBM25Query('')).toBe('');
  });

  it('preserves unicode letters and digits', () => {
    expect(escapeBM25Query('café 123')).toBe('"café" OR "123"');
    expect(escapeBM25Query('日本語')).toBe('"日本語"');
  });

  it('keeps CamelCase as single token (no internal split in v2.7)', () => {
    expect(escapeBM25Query('useState')).toBe('"useState"');
    expect(escapeBM25Query('XMLHttpRequest')).toBe('"XMLHttpRequest"');
  });

  it('strips underscores and hyphens (v2.7 default tokenizer)', () => {
    expect(escapeBM25Query('snake_case')).toBe('"snakecase"');
    expect(escapeBM25Query('kebab-case')).toBe('"kebabcase"');
  });

  it('OR-joins multi-token queries so the BM25 lane stays populated under RRF', () => {
    // v0.5.2 bug: tokens were rejoined with a bare space, which FTS5
    // interprets as implicit AND. Natural-language queries like "zod
    // object pick" required EVERY token to co-occur in a single chunk
    // → 0 rows → hybrid silently degraded to vector-only despite
    // reporting `mode: "hybrid"`. The fix OR-joins quoted tokens so the
    // BM25 lane returns high-recall candidates; BM25 ranking still favors
    // chunks that match more tokens. Quoting protects tokens that happen
    // to equal FTS5 keywords (AND, OR, NOT, NEAR) after stripping.
    const out = escapeBM25Query('zod object pick');
    // Two ` OR ` separators for three input tokens.
    expect(out.match(/ OR /g) ?? []).toHaveLength(2);
    // Every alphanumeric token from the input survives.
    for (const tok of ['zod', 'object', 'pick']) {
      expect(out).toContain(tok);
    }
  });
});
