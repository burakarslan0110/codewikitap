/**
 * Runtime heartbeat — pure-stderr metric emitter.
 *
 * Emits `runtime_heartbeat` with rssMb / uptimeSec / inFlightToolCount every
 * `intervalMs` so post-mortem analysis of `-32000` disconnects has telemetry
 * beyond "the process is gone." Reads `process.memoryUsage().rss` and
 * `process.uptime()` directly; `inFlightToolCount` comes from the
 * `withMetrics` module-level counter (injected via getInFlightCount so this
 * helper stays a pure function).
 *
 * `setInterval(...).unref()` is critical — without it, the heartbeat keeps
 * the event loop alive past `closer()` and the process won't exit on
 * shutdown. The `stop()` handle clears the timer; the closer() shutdown
 * sequence in src/index.ts calls it before cache.close().
 */

export interface HeartbeatLogger {
  metric(name: string, value: number, tags?: Record<string, unknown>): void;
}

export interface HeartbeatOptions {
  readonly log: HeartbeatLogger;
  readonly getInFlightCount: () => number;
  readonly intervalMs: number;
}

export interface HeartbeatHandle {
  stop(): void;
}

export function startHeartbeat(opts: HeartbeatOptions): HeartbeatHandle {
  const { log, getInFlightCount, intervalMs } = opts;

  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const toMb = (b: number): number => Math.round(b / (1024 * 1024));
    // v0.7.1: split RSS into V8 heap vs native ("external") so OOM forensics
    // can distinguish V8-internal pressure (heapUsed) from
    // ONNX/sqlite-vec/better-sqlite3 native allocations (external + rss -
    // heapTotal). The v0.7.0 cap `--max-old-space-size` only constrains V8
    // old-space; native bytes were invisible in the previous heartbeat.
    log.metric('runtime_heartbeat', 1, {
      rssMb: toMb(mem.rss),
      heapUsedMb: toMb(mem.heapUsed),
      heapTotalMb: toMb(mem.heapTotal),
      externalMb: toMb(mem.external),
      uptimeSec: Math.round(process.uptime()),
      inFlightToolCount: getInFlightCount(),
    });
  }, intervalMs);

  // unref() prevents the heartbeat from holding the event loop alive past
  // shutdown — without it, the process would hang waiting for the next tick.
  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
