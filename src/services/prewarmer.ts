/**
 * Prewarmer (v2.8). Single-worker background queue that, on MCP server boot,
 * eagerly walks direct-dependency repos and seeds `Indexer.indexRepo(repo)`
 * for those with `hasWiki=true`. The user's first query that arrives AFTER
 * a repo has been prewarmed hits the freshness short-circuit and skips the
 * 5 s retriever race.
 *
 * Lifecycle:
 *   const p = buildPrewarmer({ client, indexer, cache });
 *   p.enqueueDeps(initialScan.dependencies);   // sync, emits prewarm_queue_size per dep
 *   p.start();                                  // sync — schedules via setImmediate
 *   // ... server runs ...
 *   await p.stop();                             // drains in-flight indexRepo
 *
 * Contract invariants (locked in by `tests/unit/prewarmer.test.ts`):
 *   - At most ONE in-flight `indexRepo` call (cap=1) — serializes through the
 *     existing 4 s/origin rate-limit gate in `CodeWikiClient.respectRateLimit`
 *     without a second primitive.
 *   - `enqueueDeps` is sync + non-blocking. The first stdio JSON-RPC frame
 *     (`initialize`) is NEVER blocked by prewarm work.
 *   - Per-dep failures (throw, no_docs, rate_limited, retry) are logged +
 *     emitted as `prewarm_skipped` and DO NOT halt the loop.
 *   - `stop()` resolves only after the current in-flight task settles, so
 *     `cache.close()` in `src/index.ts:closer()` runs against a quiescent SQLite
 *     handle (no SQLITE_BUSY on the indexer's atomic transaction).
 */

import { getLogger, type Logger } from '../logging.js';
import { resolveRepo as defaultResolveRepo } from './repo_resolver.js';
import { PREWARM_MAX_DEPS, PREWARM_START_DELAY_MS } from '../config.js';
import type { Dependency, Ecosystem } from '../types.js';
import type { CodeWikiClient, NoWikiResult, ProbeResult } from './codewiki_client.js';
import type { Indexer, IndexerResult } from './indexer.js';
import type { Cache } from './cache.js';

export type ResolveRepoFn = (
  name: string,
  ecosystem: Ecosystem,
) => Promise<{ owner: string; repo: string } | null>;

export interface PrewarmerDeps {
  client: Pick<CodeWikiClient, 'probe'>;
  indexer: Pick<Indexer, 'indexRepo'>;
  cache: Pick<Cache, 'getRepo' | 'setRepo' | 'getWikiStatus'>;
  log?: Logger;
  /** Test seam: replace network resolver. Defaults to `repo_resolver.resolveRepo`. */
  resolve?: ResolveRepoFn;
  /** Test seam: replace `setImmediate`. */
  scheduler?: (fn: () => void) => void;
  /** Test seam: replace `setTimeout`-based start delay. */
  delay?: (fn: () => void, ms: number) => void;
  /** Per-instance cap override. Falls back to env-derived `PREWARM_MAX_DEPS`. */
  maxDeps?: number;
  /** Per-instance start-delay override. Falls back to `PREWARM_START_DELAY_MS`. */
  startDelayMs?: number;
}

interface ResolvedTarget {
  full: string;
  hasWiki: boolean;
}

/**
 * Periodic head-pointer compaction threshold. When `head > QUEUE_COMPACT_AT`
 * the array is reallocated via `slice(head)` to bound array growth in
 * long-running sessions with many manifest edits.
 */
const QUEUE_COMPACT_AT = 1000;

export class Prewarmer {
  private readonly client: PrewarmerDeps['client'];
  private readonly indexer: PrewarmerDeps['indexer'];
  private readonly cache: PrewarmerDeps['cache'];
  private readonly log: Logger;
  private readonly resolve: ResolveRepoFn;
  private readonly scheduler: (fn: () => void) => void;
  private readonly delay: (fn: () => void, ms: number) => void;
  private readonly maxDeps: number;
  private readonly startDelayMs: number;

  private queue: Dependency[] = [];
  private head = 0;
  private running = false;
  private worker: Promise<void> | null = null;
  private inflight: Promise<IndexerResult> | null = null;
  private drainedSignal: Promise<void> = Promise.resolve();
  private drainedResolve: (() => void) | null = null;

  constructor(deps: PrewarmerDeps) {
    this.client = deps.client;
    this.indexer = deps.indexer;
    this.cache = deps.cache;
    this.log = deps.log ?? getLogger();
    this.resolve = deps.resolve ?? (defaultResolveRepo as ResolveRepoFn);
    this.scheduler = deps.scheduler ?? ((fn): void => { setImmediate(fn); });
    this.delay = deps.delay ?? ((fn, ms): void => { setTimeout(fn, ms).unref?.(); });
    this.maxDeps = deps.maxDeps ?? PREWARM_MAX_DEPS;
    this.startDelayMs = deps.startDelayMs ?? PREWARM_START_DELAY_MS;
  }

  /** Current queue size (deps remaining, including in-flight). */
  get queueSize(): number {
    return this.queue.length - this.head;
  }

  /**
   * Append deps to the queue, partitioned runtime-first then dev. Sync;
   * emits one `prewarm_queue_size phase=enqueue` line per appended dep.
   * When `maxDeps > 0` and the cap is reached, further deps are dropped
   * with `prewarm_skipped reason=cap` + a single warn-log.
   */
  enqueueDeps(deps: Dependency[]): void {
    if (deps.length === 0) return;
    const runtime: Dependency[] = [];
    const dev: Dependency[] = [];
    for (const d of deps) {
      // Undefined kind treated as runtime (back-compat — see types.ts).
      if (d.kind === 'dev') dev.push(d);
      else runtime.push(d);
    }
    const ordered = [...runtime, ...dev];
    let dropped = 0;
    for (const d of ordered) {
      const accepted = this.queue.length - this.head; // currently queued
      if (this.maxDeps > 0 && accepted >= this.maxDeps) {
        this.log.metric('prewarm_skipped', 0, {
          repo: `${d.name}@${d.ecosystem}`,
          reason: 'cap',
        });
        dropped++;
        continue;
      }
      this.queue.push(d);
      this.log.metric('prewarm_queue_size', this.queue.length - this.head, {
        phase: 'enqueue',
      });
    }
    if (dropped > 0) {
      this.log.warn('prewarm_cap_dropped', { dropped, cap: this.maxDeps });
    }
    // If the worker is running, it will pick up the new deps on its next
    // loop iteration. If not yet started, the deps wait for start().
    this.armDrainedSignal();
  }

  /**
   * Kick the background worker. Returns synchronously; actual work is
   * scheduled via `setImmediate` (or the injected scheduler) so the JS
   * event loop yields to the stdio transport setup. Calling start()
   * multiple times is idempotent — the second call is a no-op while
   * `running === true`.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.armDrainedSignal();
    // stop() relies on the `!this.running` check below to no-op the deferred
    // kick when the start-delay timer fires after stop() — the timer is
    // .unref'd so it cannot hold the process open, and the kick is a pure
    // no-op when running has flipped to false (Claude review iter 2 #2).
    const kick = (): void => {
      if (!this.running) return;
      this.worker = this.run();
    };
    if (this.startDelayMs > 0) {
      this.delay(() => this.scheduler(kick), this.startDelayMs);
    } else {
      this.scheduler(kick);
    }
  }

  /**
   * Halt the worker. Resolves AFTER the current in-flight `indexRepo` (if
   * any) settles. Safe to call when not running. After stop() the queue
   * may still hold deps — they are not processed; call `enqueueDeps` again
   * and `start()` to resume.
   */
  async stop(): Promise<void> {
    if (!this.running && this.worker === null) return;
    this.running = false;
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* worker loop catches its own errors */
      }
    }
    if (this.worker) {
      try {
        await this.worker;
      } catch {
        /* worker loop catches its own errors */
      }
      this.worker = null;
    }
  }

  /**
   * Resolves when the queue is fully drained (natural exit of the worker
   * loop, NOT a `stop()`). Test helper for asserting the post-drain state.
   * If called before start(), waits for the first drain after start().
   */
  drained(): Promise<void> {
    return this.drainedSignal;
  }

  private armDrainedSignal(): void {
    if (this.drainedResolve !== null) return;
    this.drainedSignal = new Promise<void>((resolve) => {
      this.drainedResolve = resolve;
    });
  }

  private signalDrained(): void {
    const r = this.drainedResolve;
    this.drainedResolve = null;
    if (r) r();
  }

  private async run(): Promise<void> {
    const startWall = Date.now();
    let totalCompleted = 0;
    let totalSkipped = 0;
    while (this.running && this.queue.length > this.head) {
      const dep = this.queue[this.head++];
      // Periodic compaction to bound array growth in long sessions.
      if (this.head > QUEUE_COMPACT_AT) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      this.log.metric('prewarm_queue_size', this.queue.length - this.head, {
        phase: 'dequeue',
      });
      const t0 = process.hrtime.bigint();
      let task: Promise<IndexerResult> | null = null;
      let resolvedFull: string | null = null;
      try {
        const target = await this.resolveAndProbe(dep);
        if (!target) {
          this.log.metric('prewarm_skipped', 0, {
            repo: `${dep.name}@${dep.ecosystem}`,
            reason: 'no_repo',
          });
          totalSkipped++;
          continue;
        }
        resolvedFull = target.full;
        if (!target.hasWiki) {
          this.log.metric('prewarm_skipped', 0, { repo: target.full, reason: 'no_wiki' });
          totalSkipped++;
          continue;
        }
        task = this.indexer.indexRepo(target.full);
        this.inflight = task;
        const r = await task;
        if (r.status !== 'ready') {
          this.log.metric('prewarm_skipped', 0, { repo: target.full, reason: r.status });
          totalSkipped++;
          continue;
        }
        const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
        const tags: Record<string, string | number | boolean> = {
          repo: target.full,
          chunkCount: r.chunkCount,
        };
        if (r.edgeCount !== undefined) tags.edgeCount = r.edgeCount;
        this.log.metric('prewarm_completed_ms', ms, tags);
        totalCompleted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const repo = resolvedFull ?? `${dep.name}@${dep.ecosystem}`;
        this.log.warn('prewarm_indexrepo_threw', { dep: `${dep.name}@${dep.ecosystem}`, repo, err: msg });
        this.log.metric('prewarm_skipped', 0, { repo, reason: 'error' });
        totalSkipped++;
      } finally {
        if (task === this.inflight) this.inflight = null;
      }
    }
    // Natural drain (NOT a stop() call) → one-shot signal for operators.
    if (this.running) {
      this.log.info('prewarm_drained', {
        totalCompleted,
        totalSkipped,
        elapsedMs: Date.now() - startWall,
      });
    }
    this.signalDrained();
  }

  private async resolveAndProbe(dep: Dependency): Promise<ResolvedTarget | null> {
    const cachedRepo = this.cache.getRepo(dep.name, dep.ecosystem);
    let resolved: { owner: string; repo: string } | null = cachedRepo
      ? { owner: cachedRepo.owner, repo: cachedRepo.repo }
      : null;
    if (!resolved) {
      const r = await this.resolve(dep.name, dep.ecosystem);
      if (r) {
        // The full Cache.setRepo signature requires source + confidence; the
        // typed Pick<> here only exposes setRepo so we cast at the call site.
        (this.cache as unknown as Cache).setRepo(
          dep.name,
          dep.ecosystem,
          r.owner,
          r.repo,
          'fuzzy',
          'low',
        );
        resolved = r;
      }
    }
    if (!resolved) return null;
    const full = `${resolved.owner}/${resolved.repo}`;
    // wiki_status cache check first — defaults to the existing 24 h TTL.
    const status = this.cache.getWikiStatus(full);
    if (status) {
      return { full, hasWiki: status.hasWiki };
    }
    const probe: ProbeResult | NoWikiResult = await this.client.probe(full);
    if ('status' in probe) {
      return { full, hasWiki: false };
    }
    return { full, hasWiki: probe.hasWiki };
  }
}

export function buildPrewarmer(deps: PrewarmerDeps): Prewarmer {
  return new Prewarmer(deps);
}
