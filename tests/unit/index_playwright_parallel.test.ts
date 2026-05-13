/**
 * RC2 (MCP `-32000` reconnect fix) — defense L6 / parallel Playwright
 * bootstrap. Locks the contract that `PlaywrightDriver.withPage` gates on
 * the `readyPromise` and surfaces `PlaywrightUnavailableError` when the
 * promise rejects. This is the unit-level proxy for the end-to-end
 * "handshake reaches the wire while playwright is still installing"
 * scenario — `tests/integration/mcp_handshake_without_playwright.integration.test.ts`
 * is the spawn-based companion.
 *
 * Pinned invariants:
 *
 *   1. While `readyPromise` is pending, `withPage` does NOT call
 *      `chromium.launch`. (Already covered by playwright_bootstrap.test.ts;
 *      this file adds the rejection-mapping coverage.)
 *   2. When `readyPromise` rejects, `withPage` rejects with a
 *      `PlaywrightUnavailableError` whose message includes the inner
 *      reason. The error carries `kind: 'playwright_unavailable'` so the
 *      `CodeWikiClient` boundary can remap it.
 *   3. The `getPlaywrightDriver(readyPromise)` accessor threads the
 *      promise into the singleton, idempotent across calls.
 */

import { describe, it, expect, afterEach } from 'vitest';

import {
  PlaywrightDriver,
  getPlaywrightDriver,
  resetPlaywrightDriverForTesting,
} from '../../src/adapters/playwright_driver.js';
import { PlaywrightUnavailableError } from '../../src/types.js';

afterEach(() => {
  resetPlaywrightDriverForTesting();
});

describe('PlaywrightDriver — RC2 parallel bootstrap (defense L6)', () => {
  it('PlaywrightUnavailableError carries kind=playwright_unavailable and the inner reason', async () => {
    const driver = new PlaywrightDriver({
      readyPromise: Promise.reject(new Error('install was canceled')),
    });
    try {
      await driver.withPage(async () => 'ok');
      expect.fail('withPage must reject when readyPromise rejects');
    } catch (err) {
      expect(err).toBeInstanceOf(PlaywrightUnavailableError);
      expect((err as PlaywrightUnavailableError).kind).toBe('playwright_unavailable');
      expect((err as Error).message).toMatch(/install was canceled/);
      // Retry envelope: the default retryAfterSeconds bound for clients.
      expect((err as PlaywrightUnavailableError).retryAfterSeconds).toBe(30);
    }
  });

  it('getPlaywrightDriver(readyPromise) threads the promise into the singleton', async () => {
    const ready = Promise.reject(new Error('npx not found'));
    // Silence the unhandled rejection — the driver constructor re-handles
    // it but the rejection chain is observed in the await below.
    ready.catch(() => {});
    const driver = getPlaywrightDriver(ready);
    await expect(driver.withPage(async () => 'ok')).rejects.toBeInstanceOf(
      PlaywrightUnavailableError,
    );
  });

  it('subsequent getPlaywrightDriver() calls ignore the readyPromise arg (singleton stickiness)', () => {
    const first = getPlaywrightDriver(Promise.resolve());
    // Pre-attach a noop catch — the rejection is intentionally observed
    // by no-one (singleton stickiness drops the arg).
    const ignored = Promise.reject(new Error('should be ignored'));
    ignored.catch(() => {});
    const second = getPlaywrightDriver(ignored);
    expect(second).toBe(first);
  });
});
