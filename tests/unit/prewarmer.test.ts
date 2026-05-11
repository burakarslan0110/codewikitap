/**
 * Prewarmer (v2.8) unit tests. Locks in the worker-loop contract:
 *   - eager probe-then-index per dep on cache miss (Truth 2)
 *   - serialization: cap=1 in-flight indexRepo, no overlap (Truth 3)
 *   - failure isolation: one throwing dep does not stop subsequent deps (Truth 5)
 *   - per-dep prewarm_queue_size emission on enqueue AND dequeue (Truth 1 enabler)
 *   - CODEWIKI_PREWARM_MAX_DEPS cap → prewarm_skipped reason=cap
 *   - prewarm_drained info line emitted exactly once at natural drain;
 *     suppressed when stop() ends the loop
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { Prewarmer, buildPrewarmer } from '../../src/services/prewarmer.js';
import type { Dependency } from '../../src/types.js';
import type { IndexerResult } from '../../src/services/indexer.js';
import type { ProbeResult, NoDocsResult } from '../../src/services/codewiki_client.js';

interface StderrLog {
  level?: string;
  msg?: string;
  value?: number;
  phase?: string;
  reason?: string;
  repo?: string;
  totalCompleted?: number;
  totalSkipped?: number;
  elapsedMs?: number;
  chunkCount?: number;
  edgeCount?: number;
  [k: string]: unknown;
}

let stderrLines: StderrLog[];
let originalWrite: typeof process.stderr.write;

beforeEach(() => {
  stderrLines = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    const text = String(chunk);
    for (const line of text.split('\n')) {
      if (line.length === 0) continue;
      try {
        stderrLines.push(JSON.parse(line) as StderrLog);
      } catch {
        // non-JSON stderr (e.g. test framework output) — ignore.
      }
    }
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalWrite;
});

function findAll(name: string): StderrLog[] {
  return stderrLines.filter((l) => l.msg === name);
}

function dep(name: string, kind: 'runtime' | 'dev' = 'runtime'): Dependency {
  return { name, ecosystem: 'npm', kind };
}

interface CallRecord {
  repo: string;
  start: number;
  end: number;
}

interface Stubs {
  client: { probe: (repo: string) => Promise<ProbeResult | NoDocsResult> };
  indexer: { indexRepo: (repo: string) => Promise<IndexerResult> };
  cache: {
    getRepo: (name: string, eco: string) => { owner: string; repo: string } | null;
    setRepo: () => void;
    getWikiStatus: (repo: string) => null;
  };
  resolve: (name: string, eco: string) => Promise<{ owner: string; repo: string } | null>;
  probeCalls: string[];
  indexCalls: CallRecord[];
  resolveCalls: Array<{ name: string; eco: string }>;
}

function makeStubs(opts: {
  hasWikiFor?: Set<string>;
  indexDelayMs?: number;
  throwOnRepo?: string;
  resolveFor?: Map<string, { owner: string; repo: string }>;
  indexResult?: (repo: string) => IndexerResult;
} = {}): Stubs {
  const probeCalls: string[] = [];
  const indexCalls: CallRecord[] = [];
  const resolveCalls: Array<{ name: string; eco: string }> = [];
  const hasWikiFor = opts.hasWikiFor ?? new Set<string>();
  const resolveFor = opts.resolveFor ?? new Map<string, { owner: string; repo: string }>();
  const defaultResult = (): IndexerResult => ({ status: 'ready', chunkCount: 1, edgeCount: 0 });
  return {
    client: {
      async probe(repo: string): Promise<ProbeResult | NoDocsResult> {
        probeCalls.push(repo);
        if (hasWikiFor.has(repo)) {
          return { hasWiki: true, pageCount: 1, pageIndex: [] };
        }
        return { status: 'no_docs', fallbacks: [] };
      },
    },
    indexer: {
      async indexRepo(repo: string): Promise<IndexerResult> {
        const start = Date.now();
        if (opts.throwOnRepo === repo) {
          throw new Error('synthetic indexer failure');
        }
        if (opts.indexDelayMs && opts.indexDelayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.indexDelayMs));
        }
        const end = Date.now();
        indexCalls.push({ repo, start, end });
        return opts.indexResult ? opts.indexResult(repo) : defaultResult();
      },
    },
    cache: {
      getRepo: (): { owner: string; repo: string } | null => null,
      setRepo: (): void => {},
      getWikiStatus: (): null => null,
    },
    resolve: async (name: string, eco: string) => {
      resolveCalls.push({ name, eco });
      return resolveFor.get(name) ?? null;
    },
    probeCalls,
    indexCalls,
    resolveCalls,
  };
}

describe('Prewarmer — worker loop contract', () => {
  it('(a) eager probe + index for cache-miss deps, ordering runtime-first then dev', async () => {
    const stubs = makeStubs({
      hasWikiFor: new Set(['o/react', 'o/zod', 'o/vitest']),
      resolveFor: new Map([
        ['react', { owner: 'o', repo: 'react' }],
        ['zod', { owner: 'o', repo: 'zod' }],
        ['vitest', { owner: 'o', repo: 'vitest' }],
      ]),
    });
    const p = buildPrewarmer({
      client: stubs.client,
      indexer: stubs.indexer,
      cache: stubs.cache,
      resolve: stubs.resolve,
    });
    // Mix dev BEFORE runtime in input — Prewarmer must reorder runtime-first.
    p.enqueueDeps([dep('vitest', 'dev'), dep('react'), dep('zod')]);
    p.start();
    await p.drained();
    expect(stubs.resolveCalls.map((c) => c.name)).toEqual(['react', 'zod', 'vitest']);
    expect(stubs.probeCalls).toEqual(['o/react', 'o/zod', 'o/vitest']);
    expect(stubs.indexCalls.map((c) => c.repo)).toEqual(['o/react', 'o/zod', 'o/vitest']);
  });

  it('(b) cap=1 — no two indexRepo invocations overlap', async () => {
    const stubs = makeStubs({
      hasWikiFor: new Set(['o/a', 'o/b', 'o/c']),
      indexDelayMs: 30,
      resolveFor: new Map([
        ['a', { owner: 'o', repo: 'a' }],
        ['b', { owner: 'o', repo: 'b' }],
        ['c', { owner: 'o', repo: 'c' }],
      ]),
    });
    const p = buildPrewarmer({
      client: stubs.client,
      indexer: stubs.indexer,
      cache: stubs.cache,
      resolve: stubs.resolve,
    });
    p.enqueueDeps([dep('a'), dep('b'), dep('c')]);
    p.start();
    await p.drained();
    // Sequential: each next start >= previous end.
    for (let i = 1; i < stubs.indexCalls.length; i++) {
      expect(stubs.indexCalls[i].start).toBeGreaterThanOrEqual(stubs.indexCalls[i - 1].end);
    }
    expect(stubs.indexCalls).toHaveLength(3);
  });

  it('(c) one throwing dep does NOT stop subsequent deps; warn-log + prewarm_skipped reason=error', async () => {
    const stubs = makeStubs({
      hasWikiFor: new Set(['o/a', 'o/b', 'o/c']),
      throwOnRepo: 'o/b',
      resolveFor: new Map([
        ['a', { owner: 'o', repo: 'a' }],
        ['b', { owner: 'o', repo: 'b' }],
        ['c', { owner: 'o', repo: 'c' }],
      ]),
    });
    const p = buildPrewarmer({
      client: stubs.client,
      indexer: stubs.indexer,
      cache: stubs.cache,
      resolve: stubs.resolve,
    });
    p.enqueueDeps([dep('a'), dep('b'), dep('c')]);
    p.start();
    await p.drained();
    expect(stubs.indexCalls.map((c) => c.repo)).toEqual(['o/a', 'o/c']); // b skipped (threw)
    const skipped = findAll('prewarm_skipped');
    expect(skipped.find((s) => s.repo === 'o/b' && s.reason === 'error')).toBeDefined();
    const completed = findAll('prewarm_completed_ms');
    expect(completed.map((c) => c.repo).sort()).toEqual(['o/a', 'o/c']);
    expect(findAll('prewarm_indexrepo_threw')).toHaveLength(1);
  });

  it('(d) prewarm_queue_size emitted ONCE PER DEP on enqueue AND once per dep on dequeue', async () => {
    const stubs = makeStubs({
      hasWikiFor: new Set(['o/a', 'o/b', 'o/c']),
      resolveFor: new Map([
        ['a', { owner: 'o', repo: 'a' }],
        ['b', { owner: 'o', repo: 'b' }],
        ['c', { owner: 'o', repo: 'c' }],
      ]),
    });
    const p = buildPrewarmer({
      client: stubs.client,
      indexer: stubs.indexer,
      cache: stubs.cache,
      resolve: stubs.resolve,
    });
    p.enqueueDeps([dep('a'), dep('b'), dep('c')]);
    const enqueueLines = findAll('prewarm_queue_size').filter((l) => l.phase === 'enqueue');
    // Three enqueue lines — sizes 1, 2, 3 in order.
    expect(enqueueLines.map((l) => l.value)).toEqual([1, 2, 3]);
    p.start();
    await p.drained();
    const dequeueLines = findAll('prewarm_queue_size').filter((l) => l.phase === 'dequeue');
    expect(dequeueLines.map((l) => l.value)).toEqual([2, 1, 0]);
  });

  it('(e) CODEWIKI_PREWARM_MAX_DEPS cap truncates with prewarm_skipped reason=cap', async () => {
    const stubs = makeStubs({
      hasWikiFor: new Set(['o/a', 'o/b']),
      resolveFor: new Map([
        ['a', { owner: 'o', repo: 'a' }],
        ['b', { owner: 'o', repo: 'b' }],
      ]),
    });
    const p = buildPrewarmer({
      client: stubs.client,
      indexer: stubs.indexer,
      cache: stubs.cache,
      resolve: stubs.resolve,
      maxDeps: 2,
    });
    p.enqueueDeps([dep('a'), dep('b'), dep('c'), dep('d')]);
    p.start();
    await p.drained();
    const cap = findAll('prewarm_skipped').filter((l) => l.reason === 'cap');
    expect(cap).toHaveLength(2); // c and d dropped at append time
    expect(stubs.indexCalls.map((c) => c.repo)).toEqual(['o/a', 'o/b']);
  });

  it('(f) prewarm_drained emitted exactly once at natural drain; suppressed when stop() ends loop', async () => {
    const stubs = makeStubs({
      hasWikiFor: new Set(['o/a', 'o/b']),
      resolveFor: new Map([
        ['a', { owner: 'o', repo: 'a' }],
        ['b', { owner: 'o', repo: 'b' }],
      ]),
    });
    const p = buildPrewarmer({
      client: stubs.client,
      indexer: stubs.indexer,
      cache: stubs.cache,
      resolve: stubs.resolve,
    });
    p.enqueueDeps([dep('a'), dep('b')]);
    p.start();
    await p.drained();
    const drained = findAll('prewarm_drained');
    expect(drained).toHaveLength(1);
    expect(drained[0].totalCompleted).toBe(2);
    expect(drained[0].totalSkipped).toBe(0);
    expect(typeof drained[0].elapsedMs).toBe('number');

    // Second Prewarmer with stop() during in-flight — drain log MUST NOT fire.
    stderrLines.length = 0;
    const stubs2 = makeStubs({
      hasWikiFor: new Set(['o/x', 'o/y']),
      indexDelayMs: 50,
      resolveFor: new Map([
        ['x', { owner: 'o', repo: 'x' }],
        ['y', { owner: 'o', repo: 'y' }],
      ]),
    });
    const p2 = buildPrewarmer({
      client: stubs2.client,
      indexer: stubs2.indexer,
      cache: stubs2.cache,
      resolve: stubs2.resolve,
    });
    p2.enqueueDeps([dep('x'), dep('y')]);
    p2.start();
    // Wait until at least one task starts, then stop.
    await new Promise((r) => setTimeout(r, 10));
    await p2.stop();
    expect(findAll('prewarm_drained')).toHaveLength(0);
  });

  it('exports Prewarmer class and buildPrewarmer factory', () => {
    expect(typeof Prewarmer).toBe('function');
    expect(typeof buildPrewarmer).toBe('function');
  });
});
