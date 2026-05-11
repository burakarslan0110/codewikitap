import { describe, it, expect, afterAll } from 'vitest';

import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';

const driver = new PlaywrightDriver({ maxConcurrentPages: 3 });

afterAll(async () => {
  await driver.close();
});

describe('PlaywrightDriver — stealth + concurrency', () => {
  it('lazy-launches the browser only on first withPage call', async () => {
    expect(driver.isLaunched).toBe(false);
    await driver.withPage(async (page) => {
      await page.setContent('<html><body>hello</body></html>');
      const html = await page.content();
      expect(html).toContain('hello');
    });
    expect(driver.isLaunched).toBe(true);
  });

  it('applies all five documented stealth signals to every page', async () => {
    await driver.withPage(async (page) => {
      await page.setContent('<html><body></body></html>');

      const signals = await page.evaluate(() => ({
        webdriver: (navigator as { webdriver?: unknown }).webdriver,
        pluginsLength: navigator.plugins.length,
        languages: Array.from(navigator.languages),
        chromeRuntime: typeof (window as { chrome?: { runtime?: unknown } }).chrome?.runtime,
      }));

      expect(signals.webdriver).toBeUndefined();
      expect(signals.pluginsLength).toBeGreaterThan(0);
      expect(signals.languages).toEqual(['en-US', 'en']);
      expect(signals.chromeRuntime).not.toBe('undefined');

      const notifPermission = await page.evaluate(() =>
        navigator.permissions.query({ name: 'notifications' as PermissionName }).then((p) => p.state),
      );
      expect(notifPermission).toBe('prompt');
    });
  });

  it('caps concurrent pages at maxConcurrentPages', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const TASK_COUNT = 5;

    const tasks = Array.from({ length: TASK_COUNT }, () =>
      driver.withPage(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => {
          release.push(resolve);
        });
        active--;
      }),
    );

    // Drain pump: release one waiter every 100ms so successive batches can
    // acquire slots and add themselves to the queue.
    let releasedCount = 0;
    while (releasedCount < TASK_COUNT) {
      await new Promise((r) => setTimeout(r, 100));
      while (release.length > 0) {
        const fn = release.shift()!;
        fn();
        releasedCount++;
      }
    }
    await Promise.all(tasks);

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
    // Verify the cap WAS hit (we fired more tasks than slots).
    expect(peak).toBe(3);
  });
});
