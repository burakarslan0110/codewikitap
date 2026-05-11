/**
 * v2.5: thin wrapper that times any MCP tool handler and emits a
 * `tool_latency_ms` metric line on stderr per call. Used by all 6 registered
 * tools to avoid 6× boilerplate.
 *
 * The wrapper preserves the handler's return shape exactly. On thrown
 * errors it emits with `status: 'error'` and re-throws (the MCP transport
 * layer translates the throw into an `isError: true` MCP response).
 *
 * Status tag: when the handler's `structuredContent.status` field is set
 * (find_chunks/find_neighbors return `'no_docs'`, `'rate_limited'`,
 * `'retry'`, `'index_building'`), the metric uses that value. Otherwise
 * `'ok'`.
 */

import { getLogger } from '../logging.js';

export function withMetrics<TArgs, TResult>(
  toolName: string,
  handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs): Promise<TResult> => {
    const start = process.hrtime.bigint();
    try {
      const result = await handler(args);
      const durMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const sc = (result as { structuredContent?: { status?: string } }).structuredContent;
      const status = sc?.status ?? 'ok';
      getLogger().metric('tool_latency_ms', durMs, { tool: toolName, status });
      return result;
    } catch (err) {
      const durMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      getLogger().metric('tool_latency_ms', durMs, { tool: toolName, status: 'error' });
      throw err;
    }
  };
}
