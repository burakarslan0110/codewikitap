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
    const rssBytes = process.memoryUsage().rss;
    const rssMb = Math.round(rssBytes / (1024 * 1024));
    const uptimeSec = Math.round(process.uptime());
    log.metric('runtime_heartbeat', 1, {
      rssMb,
      uptimeSec,
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
