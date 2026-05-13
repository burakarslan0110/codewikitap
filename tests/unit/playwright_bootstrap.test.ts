/**
 * RED test for the MCP `-32000` reconnect bug — RC2 / Playwright bootstrap.
 *
 * Today (src/index.ts:184) `main()` awaits `ensurePlaywright()` BEFORE
 * constructing the stdio transport. When the Playwright `chromium-headless-shell`
 * binary is missing, `ensurePlaywright()` calls `runInstall()` which spawns
 * `npx playwright install` with NO timeout. On slow networks the install
 * takes 60–180+ s. `transport.connect()` is never reached, the MCP client's
 * startup timeout fires, and the subprocess is killed with JSON-RPC `-32000`.
 *
 * The fix decouples Playwright bootstrap from the MCP critical path:
 * `ensurePlaywright()` runs in parallel; its promise is threaded into
 * `PlaywrightDriver` as a `readyPromise`. `driver.withPage` gates its
 * `chromium.launch` on the promise so browser-using tools see a clean
 * `retry` envelope while the install is in flight, and non-browser tools
 * work immediately.
 *
 * This test pins the new contract: `PlaywrightDriver` accepts a
 * `readyPromise` option, and `withPage` does NOT call `chromium.launch`
 * until the promise resolves. When the promise rejects, `withPage` rejects
 * with a `PlaywrightUnavailableError`.
 *
 * Status BEFORE the fix: FAILS — the constructor does not accept
 * `readyPromise`, so the test fails to typecheck.
 * Status AFTER the fix: PASSES.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { PlaywrightUnavailableError } from '../../src/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlaywrightDriver — readyPromise gate (RC2)', () => {
  it('playwright_driver_with_page_gates_on_ready_promise', async () => {
    // A readyPromise that never resolves models the install-in-flight state.
    const driver = new PlaywrightDriver({ readyPromise: new Promise<void>(() => {}) });

    // Race withPage against a short timer; the timer MUST win, proving
    // withPage is parked on the gate (not launching chromium).
    const TIMED_OUT = Symbol('timed_out');
    const result = await Promise.race([
      driver.withPage(async () => 'ok').catch((err) => err),
      new Promise<typeof TIMED_OUT>((r) => setTimeout(() => r(TIMED_OUT), 100)),
    ]);
    expect(
      result,
      'withPage must NOT resolve while readyPromise is pending — chromium.launch must wait on the gate',
    ).toBe(TIMED_OUT);
  });

  it('playwright_driver_with_page_surfaces_unavailable_error_on_ready_rejection', async () => {
    const driver = new PlaywrightDriver({
      readyPromise: Promise.reject(new Error('playwright install failed')),
    });

    await expect(driver.withPage(async () => 'ok')).rejects.toBeInstanceOf(
      PlaywrightUnavailableError,
    );
  });
});
