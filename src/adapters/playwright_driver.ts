/**
 * Singleton Playwright driver. ALL Chromium interaction lives here.
 *
 * Design:
 *  - Lazy launch on first `withPage()` call.
 *  - One Chromium browser, one shared BrowserContext with stealth signals
 *    injected via `addInitScript` (single literal string `STEALTH_INIT_SCRIPT`).
 *  - Bounded concurrency via a semaphore — at most `maxConcurrentPages` pages
 *    may be open at once. Excess callers wait in a FIFO queue.
 *  - Process signal handlers (SIGINT/SIGTERM/beforeExit) registered exactly
 *    once at module load to close the browser cleanly.
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { MAX_CONCURRENT_PAGES, PAGE_LOAD_TIMEOUT_MS } from '../config.js';

export const STEALTH_INIT_SCRIPT = `
// 1. webdriver flag
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

// 2. plugins (real Chrome reports a non-empty array)
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });

// 3. languages aligned with locale
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

// 4. chrome.runtime — bot detectors check for its existence
if (!('chrome' in window)) {
  Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {} }) });
}

// 5. Permissions API quirk — real Chrome returns 'prompt' for notifications
const _origPermQuery = window.navigator.permissions && window.navigator.permissions.query;
if (_origPermQuery) {
  window.navigator.permissions.query = (p) => (
    p && p.name === 'notifications'
      ? Promise.resolve({ state: 'prompt' })
      : _origPermQuery.call(window.navigator.permissions, p)
  );
}
`;

const STEALTH_HEADERS = {
  'Sec-CH-UA': '"Not.A/Brand";v="8", "Chromium";v="121", "Google Chrome";v="121"',
  'Sec-CH-UA-Platform': '"macOS"',
  'Sec-CH-UA-Mobile': '?0',
  'Accept-Language': 'en-US,en;q=0.9',
};

const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

export interface PlaywrightDriverOptions {
  maxConcurrentPages?: number;
  channel?: 'chromium' | 'chromium-headless-shell';
}

export class PlaywrightDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private launchPromise: Promise<void> | null = null;

  private readonly maxConcurrentPages: number;
  private readonly channel: 'chromium' | 'chromium-headless-shell';

  // Semaphore: counter + FIFO queue of waiting callers.
  private slotsAvailable: number;
  private waiters: Array<() => void> = [];

  constructor(opts: PlaywrightDriverOptions = {}) {
    this.maxConcurrentPages = opts.maxConcurrentPages ?? MAX_CONCURRENT_PAGES;
    this.channel = opts.channel ?? 'chromium-headless-shell';
    this.slotsAvailable = this.maxConcurrentPages;
  }

  get isLaunched(): boolean {
    return this.browser !== null;
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    await this.ensureLaunched();
    await this.acquireSlot();
    let page: Page | null = null;
    try {
      page = await this.context!.newPage();
      page.setDefaultTimeout(PAGE_LOAD_TIMEOUT_MS);
      return await fn(page);
    } finally {
      if (page) {
        try { await page.close(); } catch { /* ignore */ }
      }
      this.releaseSlot();
    }
  }

  async close(): Promise<void> {
    if (this.context) {
      try { await this.context.close(); } catch { /* ignore */ }
      this.context = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignore */ }
      this.browser = null;
    }
    this.launchPromise = null;
  }

  private async ensureLaunched(): Promise<void> {
    if (this.browser) return;
    if (this.launchPromise) {
      await this.launchPromise;
      return;
    }
    this.launchPromise = this.doLaunch();
    try {
      await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  private async doLaunch(): Promise<void> {
    this.browser = await chromium.launch({ channel: this.channel });
    this.context = await this.browser.newContext({
      userAgent: REALISTIC_USER_AGENT,
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: STEALTH_HEADERS,
    });
    await this.context.addInitScript({ content: STEALTH_INIT_SCRIPT });
  }

  private async acquireSlot(): Promise<void> {
    if (this.slotsAvailable > 0) {
      this.slotsAvailable--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.slotsAvailable--;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.slotsAvailable++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton + signal handlers
// ---------------------------------------------------------------------------

let _instance: PlaywrightDriver | null = null;
let _signalsRegistered = false;

export function getPlaywrightDriver(): PlaywrightDriver {
  if (!_instance) {
    _instance = new PlaywrightDriver();
    if (!_signalsRegistered) {
      _signalsRegistered = true;
      const closer = () => {
        if (_instance) {
          _instance.close().catch(() => { /* ignore */ });
        }
      };
      process.on('SIGINT', closer);
      process.on('SIGTERM', closer);
      process.on('beforeExit', closer);
    }
  }
  return _instance;
}
