import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Logger } from '../../src/logging.js';

describe('Logger', () => {
  let tmpDir: string;
  let logFile: string;
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-mcp-log-'));
    logFile = path.join(tmpDir, 'server.log');
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a JSON line to stderr at info level', () => {
    const log = new Logger({ logFilePath: logFile, level: 'info', flushIntervalMs: 0 });
    log.info('hello', { kind: 'test' });
    log.flushSync();

    const line = stderrWrites.find((l) => l.includes('hello'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!.trim());
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('hello');
    expect(parsed.kind).toBe('test');
    expect(typeof parsed.time).toBe('string');
  });

  it('respects level filter (debug suppressed at info)', () => {
    const log = new Logger({ logFilePath: logFile, level: 'info', flushIntervalMs: 0 });
    log.debug('not visible');
    log.info('visible');
    log.flushSync();

    const joined = stderrWrites.join('');
    expect(joined).not.toContain('not visible');
    expect(joined).toContain('visible');
  });

  it('writes to the rotating file', () => {
    const log = new Logger({ logFilePath: logFile, level: 'info', flushIntervalMs: 0 });
    log.info('persisted', { id: 42 });
    log.flushSync();

    expect(fs.existsSync(logFile)).toBe(true);
    const contents = fs.readFileSync(logFile, 'utf8');
    const line = contents.trim().split('\n').find((l) => l.includes('persisted'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!);
    expect(parsed.msg).toBe('persisted');
    expect(parsed.id).toBe(42);
  });

  it('rotates file when maxBytes is exceeded', () => {
    const log = new Logger({
      logFilePath: logFile,
      level: 'info',
      flushIntervalMs: 0,
      maxBytes: 200, // tiny so any line forces rotation
      maxRotations: 2,
    });
    // First write — well under 200 bytes — creates the file but does not rotate.
    log.info('first');
    log.flushSync();
    // Second write — pushes total above 200 bytes — should rotate.
    log.info('second-line-with-some-padding-to-force-rotation', { padding: 'x'.repeat(150) });
    log.flushSync();
    log.info('third');
    log.flushSync();

    const rotated = path.join(tmpDir, 'server.log.1');
    expect(fs.existsSync(rotated)).toBe(true);
    // Active file contains the third write (post-rotation)
    expect(fs.readFileSync(logFile, 'utf8')).toContain('third');
  });

  it('error and warn levels are also emitted at default info level', () => {
    const log = new Logger({ logFilePath: logFile, level: 'info', flushIntervalMs: 0 });
    log.warn('warning-msg');
    log.error('error-msg');
    log.flushSync();

    const joined = stderrWrites.join('');
    expect(joined).toContain('warning-msg');
    expect(joined).toContain('error-msg');
    const parsedLines = joined
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
    expect(parsedLines.find((p) => p.msg === 'warning-msg')?.level).toBe('warn');
    expect(parsedLines.find((p) => p.msg === 'error-msg')?.level).toBe('error');
  });

  // v2.5: metric() emits level=metric on stderr; filtered by LOG_LEVEL=warn.
  it('metric() emits a JSON line at level=metric with name + value + tags', () => {
    const log = new Logger({ logFilePath: logFile, level: 'info', flushIntervalMs: 0 });
    log.metric('tool_latency_ms', 42, { tool: 'list_pages', status: 'ok' });
    log.flushSync();

    const line = stderrWrites.find((l) => l.includes('tool_latency_ms'));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line!.trim());
    expect(parsed.level).toBe('metric');
    expect(parsed.msg).toBe('tool_latency_ms');
    expect(parsed.value).toBe(42);
    expect(parsed.tool).toBe('list_pages');
    expect(parsed.status).toBe('ok');
  });

  it('LOG_LEVEL=warn suppresses metrics (rank 25 < rank 30)', () => {
    const log = new Logger({ logFilePath: logFile, level: 'warn', flushIntervalMs: 0 });
    log.metric('cache_hit', 1, { table: 'repos' });
    log.warn('still emitted');
    log.flushSync();

    const joined = stderrWrites.join('');
    expect(joined).not.toContain('cache_hit');
    expect(joined).toContain('still emitted');
  });

  it('LOG_LEVEL=info (default) emits metrics (rank 25 >= rank 20)', () => {
    const log = new Logger({ logFilePath: logFile, level: 'info', flushIntervalMs: 0 });
    log.metric('cache_hit', 1, { table: 'repos' });
    log.flushSync();
    expect(stderrWrites.join('')).toContain('cache_hit');
  });
});

describe('Logger — v2.6 MetricAggregator integration', () => {
  let tmpDir: string;
  let logFile: string;
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-mcp-agg-'));
    logFile = path.join(tmpDir, 'server.log');
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('toggle OFF (default): metric() emits per-event exactly as v2.5', () => {
    const log = new Logger({
      logFilePath: logFile,
      level: 'info',
      flushIntervalMs: 0,
      metricAggregate: { enabled: false, flushIntervalMs: 0, highVolumeNames: ['cache_hit'] },
    });
    log.metric('cache_hit', 1, { table: 'repos' });
    log.flushSync();
    const lines = stderrWrites.filter((l) => l.includes('"msg":"cache_hit"'));
    expect(lines.length).toBe(1); // exactly one per-event line
    const parsed = JSON.parse(lines[0].trim());
    expect(parsed.agg).toBeUndefined();
  });

  it('toggle ON + high-volume name: per-event line is suppressed', () => {
    const log = new Logger({
      logFilePath: logFile,
      level: 'info',
      flushIntervalMs: 0,
      metricAggregate: { enabled: true, flushIntervalMs: 0, highVolumeNames: ['cache_hit', 'cache_miss'] },
    });
    log.metric('cache_hit', 1, { table: 'repos' });
    log.metric('cache_hit', 1, { table: 'repos' });
    log.metric('cache_miss', 1, { table: 'repos' });
    log.flushSync();
    // Per-event lines suppressed (not yet flushed).
    const perEvent = stderrWrites.filter((l) => l.includes('"msg":"cache_hit"') && !l.includes('"agg":true'));
    expect(perEvent.length).toBe(0);
  });

  it('toggle ON + low-volume name: per-event line is preserved', () => {
    const log = new Logger({
      logFilePath: logFile,
      level: 'info',
      flushIntervalMs: 0,
      metricAggregate: { enabled: true, flushIntervalMs: 0, highVolumeNames: ['cache_hit'] },
    });
    log.metric('tool_latency_ms', 42, { tool: 'find_chunks' });
    log.flushSync();
    const perEvent = stderrWrites.filter((l) => l.includes('"msg":"tool_latency_ms"') && !l.includes('"agg":true'));
    expect(perEvent.length).toBe(1);
  });

  it('close() flushes pending aggregate buckets with computed p50/p95', () => {
    const log = new Logger({
      logFilePath: logFile,
      level: 'info',
      flushIntervalMs: 0,
      metricAggregate: { enabled: true, flushIntervalMs: 0, highVolumeNames: ['cache_hit'] },
    });
    // Emit a bunch of cache_hit events with a known distribution.
    for (let i = 1; i <= 100; i++) log.metric('cache_hit', i, { table: 'pages' });
    log.close();
    const aggLines = stderrWrites.filter((l) => l.includes('"agg":true') && l.includes('"msg":"cache_hit"'));
    expect(aggLines.length).toBe(1);
    const parsed = JSON.parse(aggLines[0].trim());
    expect(parsed.count).toBe(100);
    expect(parsed.sum).toBe(5050); // 1..100
    expect(parsed.min).toBe(1);
    expect(parsed.max).toBe(100);
    // p50 / p95 from sorted 1..100 — floor(0.5*100)=50 (value 51), floor(0.95*100)=95 (value 96)
    expect(parsed.p50).toBe(51);
    expect(parsed.p95).toBe(96);
    expect(parsed.table).toBe('pages');
  });

  it('aggregator buckets by (name, tags): different tag values are separate buckets', () => {
    const log = new Logger({
      logFilePath: logFile,
      level: 'info',
      flushIntervalMs: 0,
      metricAggregate: { enabled: true, flushIntervalMs: 0, highVolumeNames: ['cache_hit'] },
    });
    log.metric('cache_hit', 1, { table: 'pages' });
    log.metric('cache_hit', 2, { table: 'pages' });
    log.metric('cache_hit', 10, { table: 'repos' });
    log.close();
    const aggLines = stderrWrites.filter((l) => l.includes('"agg":true') && l.includes('"msg":"cache_hit"'));
    expect(aggLines.length).toBe(2);
    const parsedRows = aggLines.map((l) => JSON.parse(l.trim()));
    const byTable = new Map(parsedRows.map((r) => [r.table, r]));
    expect(byTable.get('pages')?.count).toBe(2);
    expect(byTable.get('pages')?.sum).toBe(3);
    expect(byTable.get('repos')?.count).toBe(1);
    expect(byTable.get('repos')?.sum).toBe(10);
  });
});
