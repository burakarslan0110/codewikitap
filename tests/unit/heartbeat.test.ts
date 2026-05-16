/**
 * Unit tests for the runtime_heartbeat helper.
 *
 * Asserts: timer fires at interval, stop() clears timer, emitted metric
 * carries the expected fields (rssMb, uptimeSec, inFlightToolCount).
 *
 * Also exercises the withMetrics in-flight counter so we catch leaks on
 * throwing handlers — a single test class covers both since the heartbeat
 * helper depends on the counter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { startHeartbeat } from '../../src/services/heartbeat.js';
import {
  withMetrics,
  getInFlightCount,
  __test_resetInFlightCount,
} from '../../src/tools/withMetrics.js';

interface MetricEvent {
  name: string;
  value: number;
  tags: Record<string, unknown> | undefined;
}

function makeLogStub(): { metric: (n: string, v: number, t?: Record<string, unknown>) => void; events: MetricEvent[] } {
  const events: MetricEvent[] = [];
  return {
    metric(name, value, tags) {
      events.push({ name, value, tags });
    },
    events,
  };
}

describe('startHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __test_resetInFlightCount();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once per interval and emits rssMb / uptimeSec / inFlightToolCount fields', () => {
    const log = makeLogStub();
    const handle = startHeartbeat({
      log: log as unknown as { metric: (n: string, v: number, t?: Record<string, unknown>) => void },
      getInFlightCount: () => 3,
      intervalMs: 1000,
    });

    expect(log.events.length).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(log.events.length).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(log.events.length).toBe(2);

    const first = log.events[0];
    expect(first.name).toBe('runtime_heartbeat');
    expect(typeof first.tags?.rssMb).toBe('number');
    expect(typeof first.tags?.uptimeSec).toBe('number');
    expect(first.tags?.inFlightToolCount).toBe(3);
    handle.stop();
  });

  it('stop() halts further emissions', () => {
    const log = makeLogStub();
    const handle = startHeartbeat({
      log: log as unknown as { metric: (n: string, v: number, t?: Record<string, unknown>) => void },
      getInFlightCount: () => 0,
      intervalMs: 100,
    });
    vi.advanceTimersByTime(100);
    expect(log.events.length).toBe(1);
    handle.stop();
    vi.advanceTimersByTime(500);
    expect(log.events.length).toBe(1); // no further ticks after stop()
  });
});

describe('heartbeat × withMetrics integration (real getInFlightCount wiring)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __test_resetInFlightCount();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emitted runtime_heartbeat reflects live in-flight handler count via real getInFlightCount', async () => {
    const log = makeLogStub();
    const handle = startHeartbeat({
      log: log as unknown as { metric: (n: string, v: number, t?: Record<string, unknown>) => void },
      // Real wiring: NOT a stub — uses the same module-level counter that
      // production startHeartbeat reads.
      getInFlightCount,
      intervalMs: 100,
    });

    // Bring 2 handlers in-flight by NOT awaiting them.
    let release1!: () => void;
    let release2!: () => void;
    const wait1 = new Promise<void>((r) => { release1 = r; });
    const wait2 = new Promise<void>((r) => { release2 = r; });
    const wrapped1 = withMetrics('h1', () => wait1.then(() => ({ ok: true } as const)));
    const wrapped2 = withMetrics('h2', () => wait2.then(() => ({ ok: true } as const)));
    const p1 = wrapped1({});
    const p2 = wrapped2({});

    // First heartbeat tick — both handlers in flight.
    vi.advanceTimersByTime(100);
    expect(log.events.at(-1)?.tags?.inFlightToolCount).toBe(2);

    // Release one — count drops to 1 in the next tick.
    release1();
    await p1;
    vi.advanceTimersByTime(100);
    expect(log.events.at(-1)?.tags?.inFlightToolCount).toBe(1);

    // Release the last — count drops to 0.
    release2();
    await p2;
    vi.advanceTimersByTime(100);
    expect(log.events.at(-1)?.tags?.inFlightToolCount).toBe(0);

    handle.stop();
  });
});

describe('withMetrics in-flight counter', () => {
  beforeEach(() => {
    __test_resetInFlightCount();
  });

  it('increments at entry, decrements at success', async () => {
    expect(getInFlightCount()).toBe(0);
    let observedDuringHandler = -1;
    const wrapped = withMetrics<unknown, { ok: true }>('demo', async () => {
      observedDuringHandler = getInFlightCount();
      return { ok: true };
    });
    await wrapped({});
    expect(observedDuringHandler).toBe(1);
    expect(getInFlightCount()).toBe(0);
  });

  it('decrements when the handler throws (no leak)', async () => {
    const wrapped = withMetrics<unknown, never>('demo', async () => {
      throw new Error('boom');
    });
    await expect(wrapped({})).rejects.toThrow('boom');
    expect(getInFlightCount()).toBe(0);
  });

  it('correctly reflects parallel in-flight handlers', async () => {
    let resolveA: (v: { ok: true }) => void = () => undefined;
    const waitA = new Promise<{ ok: true }>((r) => { resolveA = r; });
    const wrappedA = withMetrics<unknown, { ok: true }>('a', () => waitA);
    const wrappedB = withMetrics<unknown, { ok: true }>('b', async () => ({ ok: true } as const));

    const promiseA = wrappedA({});
    expect(getInFlightCount()).toBe(1);
    await wrappedB({});
    expect(getInFlightCount()).toBe(1); // B finished, A still running
    resolveA({ ok: true });
    await promiseA;
    expect(getInFlightCount()).toBe(0);
  });
});
