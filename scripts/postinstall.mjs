#!/usr/bin/env node
/**
 * codewikitap postinstall — fetch Playwright's chromium-headless-shell once.
 *
 * Why this exists: codewikitap fetches Google CodeWiki pages via Playwright
 * because CodeWiki is an Angular SPA (a plain HTTP GET returns an empty shell).
 * From Playwright v1.40+ the `playwright` npm package no longer auto-downloads
 * browser binaries during its own postinstall, so we drive `playwright install`
 * ourselves. Without this step, the first `find_chunks` / `get_page` call would
 * error with "browserType.launch: Executable doesn't exist…".
 *
 * Safety contract:
 *   - Idempotent: `playwright install` skips fast when the binary is cached.
 *   - Fail-soft: on download failure (offline, sandbox, restricted CI) we print
 *     a recovery command and exit 0 so `npm install` itself succeeds. The
 *     package is still usable for read-only tools that don't need the browser.
 *   - Opt-out: set CODEWIKI_SKIP_POSTINSTALL=1 to skip (CI image builders,
 *     containers that already pre-fetch browsers, smoke tests).
 *   - Quiet by default in non-TTY: shrinks log noise for nested installs.
 */

import { execSync } from 'node:child_process';

const SKIP = process.env.CODEWIKI_SKIP_POSTINSTALL === '1';
const isTTY = process.stdout.isTTY === true;

function log(msg) {
  process.stdout.write(`[codewikitap] ${msg}\n`);
}
function warn(msg) {
  process.stderr.write(`[codewikitap] ${msg}\n`);
}

if (SKIP) {
  log('CODEWIKI_SKIP_POSTINSTALL=1 set — skipping browser download.');
  process.exit(0);
}

log('Installing Playwright chromium-headless-shell (~30 MB, one-time, cached after first run)…');

try {
  execSync('npx --yes playwright install --only-shell chromium', {
    stdio: isTTY ? 'inherit' : ['ignore', 'inherit', 'inherit'],
    timeout: 180_000,
  });
  log('Browser ready.');
  process.exit(0);
} catch (err) {
  warn('');
  warn('WARNING — failed to install Playwright chromium-headless-shell.');
  warn('The package is installed and will run, but `find_chunks` and `get_page`');
  warn('will error until you complete the browser install manually:');
  warn('');
  warn('    npx playwright install --only-shell chromium');
  warn('');
  if (err && typeof err.message === 'string') {
    warn(`Reason: ${err.message.split('\n')[0]}`);
  }
  // Never fail the host install.
  process.exit(0);
}
