/**
 * stdio integrity helpers (MCP -32000 fix — RC1 defense-in-depth).
 *
 * The legacy embedder/reranker wrap (`src/adapters/embedder.ts` / `reranker.ts`)
 * globally replaced `process.stdout.write` for the entire duration of a model
 * load. Because that wrap straddled async `await` points, any CONCURRENT
 * JSON-RPC frame written by the MCP SDK during the load was silently rerouted
 * to stderr — clients then timed out and surfaced `-32000` reconnect errors.
 *
 * This module is the on-shelf replacement for that wrap. Two exports:
 *
 *   - `assertStdoutPureDuring(fn)` (TEST-ONLY) — capture-and-buffer
 *     `process.stdout.write` for the duration of `fn`, return the bytes
 *     captured plus the fn's result. Used by tests to assert that
 *     `@xenova/transformers` (or any other library) writes zero bytes to
 *     stdout during a controlled scenario.
 *
 *   - `installStdoutTripwire(log)` (DIAGNOSTIC RUNTIME) — install a
 *     SIDE-OBSERVE wrapper around `process.stdout.write` that ALWAYS
 *     forwards every byte to the real stdout and IN ADDITION logs a
 *     warn-line when a written chunk does not look like a valid JSON-RPC
 *     frame (i.e., does not start with `{` or `\n`). Off by default;
 *     opt-in via `CODEWIKI_STDOUT_TRIPWIRE=1`. Returns an uninstaller.
 *
 * Neither helper ever REROUTES stdout. The runtime tripwire is purely
 * observational — that property is what makes it safe to leave installed
 * for the lifetime of the MCP server.
 */

import type { Logger } from '../logging.js';

export interface StdoutPurityResult<T> {
  result: T;
  bytesWritten: number;
  chunks: string[];
}

/**
 * Test-only helper. Captures every `process.stdout.write` call for the
 * duration of `fn` into an in-memory buffer (nothing reaches the real
 * stdout). Restores the original `process.stdout.write` on completion
 * — guaranteed even when `fn` throws.
 *
 * NEVER call from production code: a concurrent JSON-RPC frame from the
 * MCP SDK during the capture window would be swallowed. This is exactly
 * the bug we're guarding against; the helper is intended for isolated
 * test scenarios where no MCP traffic is in flight.
 */
export async function assertStdoutPureDuring<T>(
  fn: () => Promise<T>,
): Promise<StdoutPurityResult<T>> {
  const chunks: string[] = [];
  // Save the method REFERENCE (not .bind'd) so the restore is identity-equal
  // to whatever was on the stream before the install. Callers that assert
  // `process.stdout.write === before` after restore rely on this.
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: unknown): boolean => {
    if (typeof chunk === 'string') chunks.push(chunk);
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk).toString('utf8'));
    return true;
  }) as NodeJS.WriteStream['write'];
  try {
    const result = await fn();
    const bytesWritten = chunks.reduce((acc, c) => acc + Buffer.byteLength(c, 'utf8'), 0);
    return { result, bytesWritten, chunks };
  } finally {
    process.stdout.write = originalWrite;
  }
}

/**
 * Runtime tripwire. Installs a side-observe wrapper around
 * `process.stdout.write` that always forwards to the real implementation
 * — the JSON-RPC bytes from the MCP SDK ALWAYS reach the client. In
 * addition, when a written chunk does not look like a JSON-RPC frame
 * (does not start with `{` or `\n`), the wrapper emits a single
 * `stdout_tripwire_byte` warn-log with a 64-char preview. Returns an
 * uninstall function that restores the original write.
 *
 * Multiple installs over the same process are idempotent — each install
 * captures the CURRENT write method as its forward target, then the
 * uninstall restores that capture. Stacking two tripwires therefore
 * works correctly (each forwards to the layer below).
 */
export function installStdoutTripwire(log: Logger): () => void {
  const originalWrite = process.stdout.write;
  const tripwire = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) {
      const preview =
        typeof chunk === 'string'
          ? chunk.slice(0, 64)
          : Buffer.from(chunk).subarray(0, 64).toString('utf8');
      const head = preview.charCodeAt(0);
      // 123 = '{', 10 = '\n'. JSON-RPC frames start with one of these.
      if (head !== 123 && head !== 10) {
        log.warn('stdout_tripwire_byte', { preview });
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (originalWrite as any).call(process.stdout, chunk, ...rest);
  }) as NodeJS.WriteStream['write'];
  process.stdout.write = tripwire;
  return (): void => {
    process.stdout.write = originalWrite;
  };
}
