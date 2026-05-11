/**
 * Stderr (line-delimited JSON) + rotating file logger.
 *
 * stdio MCP servers must NEVER write to stdout (it is reserved for the JSON-RPC
 * protocol). All structured logs go to stderr; a copy is also persisted to a
 * rotating file under XDG_STATE_HOME/codewiki-mcp/server.log for forensics.
 *
 * The file write is sync-batched (in-memory queue flushed every flushIntervalMs)
 * so log-heavy paths don't pay per-call I/O.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  LOG_FILE_PATH,
  LOG_LEVEL,
  LOG_FILE_MAX_BYTES,
  LOG_FILE_MAX_ROTATIONS,
  LOG_FLUSH_INTERVAL_MS,
  METRIC_AGGREGATE_ENABLED,
  METRIC_FLUSH_INTERVAL_MS,
  METRIC_AGGREGATE_HIGH_VOLUME_NAMES,
} from './config.js';

/**
 * v2.6: opt-in in-process metric aggregator. When enabled, bucket metric
 * events by (name, tagFingerprint) and emit one aggregated JSON line per
 * bucket on a periodic timer. High-volume names (`cache_hit`, `cache_miss`)
 * are suppressed at per-event level when the aggregator is on — debugging
 * value is bounded vs. log volume. Low-volume names (`tool_latency_ms`,
 * `index_build_ms`) keep per-event emission AND also flow into aggregation.
 */
const MAX_SAMPLES_PER_BUCKET = 1000;

interface AggregateBucket {
  name: string;
  tags: Record<string, string | number | boolean>;
  count: number;
  sum: number;
  min: number;
  max: number;
  samples: number[]; // FIFO-evicted at MAX_SAMPLES_PER_BUCKET
}

export interface AggregateRecord {
  name: string;
  agg: true;
  count: number;
  sum: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  [tag: string]: unknown;
}

export class MetricAggregator {
  private readonly buckets = new Map<string, AggregateBucket>();

  record(name: string, value: number, tags?: Record<string, string | number | boolean>): void {
    const cleanTags = tags ?? {};
    const key = bucketKey(name, cleanTags);
    let b = this.buckets.get(key);
    if (!b) {
      b = { name, tags: cleanTags, count: 0, sum: 0, min: value, max: value, samples: [] };
      this.buckets.set(key, b);
    }
    b.count += 1;
    b.sum += value;
    if (value < b.min) b.min = value;
    if (value > b.max) b.max = value;
    if (b.samples.length >= MAX_SAMPLES_PER_BUCKET) {
      b.samples.shift(); // FIFO eviction
    }
    b.samples.push(value);
  }

  /** Flush all buckets via `emit` and reset state. Idempotent on empty state. */
  flush(emit: (record: AggregateRecord) => void): void {
    for (const b of this.buckets.values()) {
      const sorted = b.samples.slice().sort((a, c) => a - c);
      const p50 = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      emit({
        name: b.name,
        agg: true,
        count: b.count,
        sum: b.sum,
        min: b.min,
        max: b.max,
        p50,
        p95,
        ...b.tags,
      });
    }
    this.buckets.clear();
  }

  /** Test-only: drop all buckets without emitting. */
  clear(): void {
    this.buckets.clear();
  }
}

function bucketKey(name: string, tags: Record<string, string | number | boolean>): string {
  const sorted = Object.keys(tags).sort();
  return `${name}|${sorted.map((k) => `${k}=${String(tags[k])}`).join(',')}`;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * sortedAsc.length)));
  return sortedAsc[idx];
}

export type LogLevel = 'debug' | 'info' | 'metric' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  metric: 25,
  warn: 30,
  error: 40,
};

/**
 * v2.5: `metric` is an OUTPUT TAG, not a settable input level. The contract:
 * users set `LOG_LEVEL=info` (or lower) to see metrics; `LOG_LEVEL=warn`
 * (rank 30) suppresses metrics via the rank-25 filter. There is NO valid
 * `LOG_LEVEL=metric` configuration — `normalizeLevel('metric')` falls
 * through to the default `'info'`.
 */
function normalizeLevel(level: string): LogLevel {
  const lc = level.toLowerCase();
  if (lc === 'debug' || lc === 'info' || lc === 'warn' || lc === 'error') {
    return lc;
  }
  return 'info';
}

export interface LoggerOptions {
  logFilePath: string;
  level: LogLevel | string;
  flushIntervalMs: number;
  maxBytes?: number;
  maxRotations?: number;
  /** v2.6: opt-in metric aggregator config; defaults to config.ts values. */
  metricAggregate?: MetricAggregateOptions;
}

export interface MetricAggregateOptions {
  enabled: boolean;
  flushIntervalMs: number;
  highVolumeNames: ReadonlyArray<string>;
}

export class Logger {
  private readonly logFilePath: string;
  private readonly level: LogLevel;
  private readonly minRank: number;
  private readonly flushIntervalMs: number;
  private readonly maxBytes: number;
  private readonly maxRotations: number;

  private queue: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private currentBytes = 0;
  private dirEnsured = false;

  // v2.6: opt-in MetricAggregator state.
  private readonly metricAggregate: MetricAggregateOptions;
  private readonly aggregator: MetricAggregator | null;
  private readonly highVolumeSet: ReadonlySet<string>;
  private aggTimer: NodeJS.Timeout | null = null;

  constructor(opts: LoggerOptions) {
    this.logFilePath = opts.logFilePath;
    this.level = normalizeLevel(typeof opts.level === 'string' ? opts.level : opts.level);
    this.minRank = LEVEL_RANK[this.level];
    this.flushIntervalMs = opts.flushIntervalMs;
    this.maxBytes = opts.maxBytes ?? LOG_FILE_MAX_BYTES;
    this.maxRotations = opts.maxRotations ?? LOG_FILE_MAX_ROTATIONS;

    if (this.flushIntervalMs > 0) {
      this.timer = setInterval(() => this.flushSync(), this.flushIntervalMs);
      // Don't keep the event loop alive just for log flushing.
      this.timer.unref?.();
    }

    // v2.6 aggregator wiring.
    this.metricAggregate = opts.metricAggregate ?? {
      enabled: METRIC_AGGREGATE_ENABLED,
      flushIntervalMs: METRIC_FLUSH_INTERVAL_MS,
      highVolumeNames: METRIC_AGGREGATE_HIGH_VOLUME_NAMES,
    };
    this.highVolumeSet = new Set(this.metricAggregate.highVolumeNames);
    if (this.metricAggregate.enabled) {
      this.aggregator = new MetricAggregator();
      if (this.metricAggregate.flushIntervalMs > 0) {
        this.aggTimer = setInterval(() => this.flushAggregator(), this.metricAggregate.flushIntervalMs);
        this.aggTimer.unref?.();
      }
    } else {
      this.aggregator = null;
    }
  }

  /** v2.6 internals: snapshot the aggregator state via the emit channel. */
  private flushAggregator(): void {
    if (!this.aggregator) return;
    this.aggregator.flush((record) => {
      // The record's `name` is the metric name; we emit it via the same
      // `emit` channel as info/warn/error using level='metric'. The aggregate
      // record's other fields (count/sum/min/max/p50/p95/...tags) are merged.
      const { name, ...rest } = record;
      this.emit('metric', name, rest as Record<string, unknown>);
    });
  }

  debug(msg: string, extra?: Record<string, unknown>): void {
    this.emit('debug', msg, extra);
  }

  info(msg: string, extra?: Record<string, unknown>): void {
    this.emit('info', msg, extra);
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    this.emit('warn', msg, extra);
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    this.emit('error', msg, extra);
  }

  /**
   * v2.5: emit a structured metric line on stderr. Routes through the
   * same `emit()` path as info/warn/error — same JSON shape, same file
   * write batching, same LOG_LEVEL filter. Metric rank is 25 (between
   * info and warn): visible at `LOG_LEVEL=info`, suppressed at
   * `LOG_LEVEL=warn`.
   *
   * Tags are flat key/value pairs (no nested objects — keeps downstream
   * tooling like Loki / Vector / Datadog Logs simple). The `value` and
   * tag keys are merged into the JSON record (no nested `tags:` object).
   */
  metric(name: string, value: number, tags?: Record<string, string | number | boolean>): void {
    if (this.aggregator) {
      // Aggregator owns the sample; mirror to per-event ONLY for low-volume names.
      this.aggregator.record(name, value, tags);
      if (this.highVolumeSet.has(name)) {
        return; // High-volume → suppress per-event emission.
      }
    }
    this.emit('metric', name, { value, ...(tags ?? {}) });
  }

  flushSync(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.join('');
    this.queue = [];

    try {
      this.ensureDir();
      this.rotateIfNeeded(batch.length);
      fs.appendFileSync(this.logFilePath, batch, { encoding: 'utf8' });
      this.currentBytes += Buffer.byteLength(batch, 'utf8');
    } catch (err) {
      // We can't log the log-write failure to ourselves; print once to stderr.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`{"level":"error","msg":"log-write-failed","reason":"${escapeForJson(msg)}"}\n`);
    }
  }

  /** Stop the flush timer. Called on process shutdown. */
  close(): void {
    if (this.aggTimer) {
      clearInterval(this.aggTimer);
      this.aggTimer = null;
    }
    // v2.6: flush any pending aggregate buckets so shutdown loses nothing.
    if (this.aggregator) {
      this.flushAggregator();
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flushSync();
  }

  private emit(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < this.minRank) return;

    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(extra ?? {}),
    };

    let line: string;
    try {
      line = JSON.stringify(record) + '\n';
    } catch {
      // Fallback: extra contained a non-serialisable value (cycle, BigInt, etc).
      line = JSON.stringify({ time: record.time, level, msg, extra_serialization_failed: true }) + '\n';
    }

    // stderr is unbuffered & atomic per write — direct write keeps the line
    // intact even if multiple sources interleave.
    process.stderr.write(line);

    // File path: queue, batched flush.
    this.queue.push(line);
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    const dir = path.dirname(this.logFilePath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.logFilePath)) {
      try {
        this.currentBytes = fs.statSync(this.logFilePath).size;
      } catch {
        this.currentBytes = 0;
      }
    } else {
      this.currentBytes = 0;
    }
    this.dirEnsured = true;
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.currentBytes + incomingBytes <= this.maxBytes) return;
    if (!fs.existsSync(this.logFilePath)) return;

    // Drop the oldest rotation.
    const oldest = `${this.logFilePath}.${this.maxRotations}`;
    if (fs.existsSync(oldest)) {
      try { fs.unlinkSync(oldest); } catch { /* ignore */ }
    }

    // Shift each rotation down by one slot.
    for (let n = this.maxRotations - 1; n >= 1; n--) {
      const src = `${this.logFilePath}.${n}`;
      const dst = `${this.logFilePath}.${n + 1}`;
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dst); } catch { /* ignore */ }
      }
    }

    // Move the active file into slot 1.
    try {
      fs.renameSync(this.logFilePath, `${this.logFilePath}.1`);
    } catch {
      /* ignore — next write will append to existing file */
    }
    this.currentBytes = 0;
  }
}

function escapeForJson(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ---------------------------------------------------------------------------
// Singleton accessor used by the rest of the codebase.
// ---------------------------------------------------------------------------

let _instance: Logger | null = null;

export function getLogger(): Logger {
  if (!_instance) {
    _instance = new Logger({
      logFilePath: LOG_FILE_PATH,
      level: LOG_LEVEL,
      flushIntervalMs: LOG_FLUSH_INTERVAL_MS,
    });
  }
  return _instance;
}
