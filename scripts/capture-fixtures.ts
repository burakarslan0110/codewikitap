/**
 * Capture CodeWiki page DOMs as test fixtures.
 *
 * Usage: `pnpm capture-fixtures`
 *
 * Replaces the unworkable "curl the page" approach (CodeWiki is an Angular
 * SPA — curl gets the empty shell). Uses the same PlaywrightDriver the
 * production scraper uses, navigates to each repo, waits for
 * `body-content-section` to render, then writes `page.content()` to a
 * fixture file.
 *
 * Re-run this script when the DOM contracts change and integration tests
 * start failing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlaywrightDriver } from '../src/adapters/playwright_driver.js';

interface Target {
  repo: string; // "owner/repo"
  fixtureName: string; // file name under tests/fixtures/codewiki/
}

const TARGETS: Target[] = [
  { repo: 'facebook/react', fixtureName: 'react.html' },
  { repo: 'vercel/next.js', fixtureName: 'next-js.html' },
  { repo: 'kubernetes/kubernetes', fixtureName: 'kubernetes.html' },
  // A real repo we expect to NOT have CodeWiki coverage (used for not-found.html).
  // If this one ever DOES get indexed, swap it for a freshly uncovered repo.
  { repo: 'this-org-does-not-exist-for-codewiki/never', fixtureName: 'not-found-live.html' },
];

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(here, '..', 'tests', 'fixtures', 'codewiki');

async function main(): Promise<void> {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  const driver = new PlaywrightDriver();

  for (const target of TARGETS) {
    const url = `https://codewiki.google/github.com/${target.repo}`;
    process.stderr.write(`Capturing ${url} → ${target.fixtureName}\n`);
    try {
      await driver.withPage(async (page) => {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
        // Wait for the SPA to render at least one section, OR a not-found marker.
        await Promise.race([
          page.waitForSelector('body-content-section', { timeout: 30_000 }),
          page.waitForSelector('text=/We couldn.t find that page/i', { timeout: 30_000 }),
        ]).catch(() => { /* ignore — capture whatever rendered */ });
        const html = await page.content();
        fs.writeFileSync(path.join(FIXTURES_DIR, target.fixtureName), html);
        process.stderr.write(`  saved ${html.length} bytes\n`);
      });
    } catch (err) {
      process.stderr.write(`  FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  await driver.close();
  process.stderr.write('Done.\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
