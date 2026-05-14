import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { withMetrics } from '../../src/tools/withMetrics.js';

describe('withMetrics', () => {
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  function findMetric(name: string): Record<string, unknown> | null {
    const line = stderrWrites
      .flatMap((w) => w.split('\n'))
      .find((l) => l.length > 0 && l.includes(`"msg":"${name}"`));
    return line ? (JSON.parse(line) as Record<string, unknown>) : null;
  }

  it('emits tool_latency_ms with status=ok on a successful handler', async () => {
    const wrapped = withMetrics('get_page', async (_args: unknown) => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { whatever: 1 },
    }));
    await wrapped({});

    const metric = findMetric('tool_latency_ms');
    expect(metric).not.toBeNull();
    expect(metric?.tool).toBe('get_page');
    expect(metric?.status).toBe('ok');
    expect(typeof metric?.value).toBe('number');
    expect(metric?.level).toBe('metric');
  });

  it('uses structuredContent.status when present', async () => {
    const wrapped = withMetrics('find_chunks', async (_args: unknown) => ({
      content: [],
      structuredContent: { status: 'index_building' },
    }));
    await wrapped({});

    const metric = findMetric('tool_latency_ms');
    expect(metric?.status).toBe('index_building');
    expect(metric?.tool).toBe('find_chunks');
  });

  it('emits status=error and re-throws when handler throws', async () => {
    const wrapped = withMetrics('get_page', async () => {
      throw new Error('boom');
    });
    await expect(wrapped({})).rejects.toThrow('boom');

    const metric = findMetric('tool_latency_ms');
    expect(metric?.status).toBe('error');
    expect(metric?.tool).toBe('get_page');
  });
});
