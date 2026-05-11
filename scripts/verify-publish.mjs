#!/usr/bin/env node
/**
 * Pre-publish smoke test for `codewikitap`.
 *
 * - Runs `pnpm pack` to produce a tarball matching what `npm publish` would ship.
 * - Installs the tarball into a temp dir.
 * - Asserts the installed package's file allowlist matches expectations
 *   (presence of dist/, README.md, README.tr.md, LICENSE, assets/logo.svg,
 *   .claude-plugin/plugin.json; absence of tests/, docs/, .github/,
 *   scripts/, node_modules/, 2026-*.md).
 * - Asserts the `codewikitap` bin file exists and is executable.
 * - Does NOT invoke the binary (src/index.ts has no --version flag handler;
 *   running it would start the stdio JSON-RPC loop and hang).
 * - Cleans up the temp dir on success, unless --keep-tmp is passed.
 *
 * Exit codes:
 *   0  — all assertions pass
 *   1  — at least one assertion failed
 *
 * Usage: node scripts/verify-publish.mjs [--keep-tmp]
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(new URL('..', import.meta.url).pathname);
const PACKAGE_NAME = 'codewikitap';
const BIN_NAME = 'codewikitap';
const KEEP_TMP = process.argv.includes('--keep-tmp');

const REQUIRED_FILES = [
  'package.json',
  'README.md',
  'README.tr.md',
  'LICENSE',
  'assets/logo.png',
  '.claude-plugin/plugin.json',
  '.claude-plugin/marketplace.json',
  '.mcp.json',
  'dist/index.js',
];

const FORBIDDEN_PATTERNS = [
  /^tests\//,
  /^docs\//,
  /^\.github\//,
  /^scripts\//,
  /^node_modules\//,
  /^\.git\//,
  /^2026-.*\.md$/,
  /^CLAUDE\.md$/,
  /^E2E_TEST_REPORT\.md$/,
];

const failures = [];
let tmpRoot = null;

function log(msg) {
  process.stdout.write(`[verify-publish] ${msg}\n`);
}

function fail(msg) {
  failures.push(msg);
  process.stderr.write(`[verify-publish] FAIL: ${msg}\n`);
}

function pass(msg) {
  process.stdout.write(`[verify-publish] OK:   ${msg}\n`);
}

function walk(dir, base = '') {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full, rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

try {
  // 1. Pack the tarball.
  log('Packing tarball via `pnpm pack`...');
  const packOutput = execSync('pnpm pack', { cwd: REPO_ROOT, encoding: 'utf8' });
  const tarballName = packOutput.trim().split('\n').filter((l) => l.endsWith('.tgz')).pop();
  if (!tarballName) {
    fail(`Could not parse tarball name from pnpm pack output:\n${packOutput}`);
    process.exit(1);
  }
  const tarballPath = resolve(REPO_ROOT, tarballName);
  if (!existsSync(tarballPath)) {
    fail(`Tarball path does not exist: ${tarballPath}`);
    process.exit(1);
  }
  const tarballSize = statSync(tarballPath).size;
  log(`Tarball: ${tarballName} (${(tarballSize / 1024).toFixed(1)} KB)`);

  // 2. Create temp dir and install the tarball.
  tmpRoot = mkdtempSync(join(tmpdir(), `${PACKAGE_NAME}-verify-`));
  log(`Temp dir: ${tmpRoot}`);

  log('Initializing temp npm workspace...');
  execSync('npm init -y', { cwd: tmpRoot, stdio: 'pipe' });

  log('Installing tarball into temp dir...');
  execSync(`npm install --no-fund --no-audit "${tarballPath}"`, {
    cwd: tmpRoot,
    stdio: 'pipe',
  });

  // 3. Locate the installed package.
  const installedRoot = join(tmpRoot, 'node_modules', PACKAGE_NAME);
  if (!existsSync(installedRoot)) {
    fail(`Installed package not found at ${installedRoot}`);
    process.exit(1);
  }
  pass(`Installed at node_modules/${PACKAGE_NAME}/`);

  // 4. Walk the installed package and assert allowlist.
  const installedFiles = walk(installedRoot);
  log(`Installed file count: ${installedFiles.length}`);

  for (const required of REQUIRED_FILES) {
    if (installedFiles.includes(required)) {
      pass(`Present: ${required}`);
    } else {
      fail(`MISSING IN TARBALL: ${required}`);
    }
  }

  for (const file of installedFiles) {
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(file)) {
        fail(`UNEXPECTED IN TARBALL: ${file} (matches ${pattern.source})`);
      }
    }
  }

  // 5. Assert bin file exists + is executable. Do NOT invoke.
  const binPath = join(tmpRoot, 'node_modules', '.bin', BIN_NAME);
  if (!existsSync(binPath)) {
    fail(`Bin file not found at node_modules/.bin/${BIN_NAME}`);
  } else {
    const binStat = statSync(binPath);
    // POSIX: any-execute bits set in mode
    const executable = (binStat.mode & 0o111) !== 0;
    if (executable) {
      pass(`Bin exists + executable: node_modules/.bin/${BIN_NAME}`);
    } else {
      fail(`Bin exists but NOT executable: node_modules/.bin/${BIN_NAME} (mode=${binStat.mode.toString(8)})`);
    }
  }

  // 6. Cleanup tarball at repo root.
  rmSync(tarballPath, { force: true });
  log(`Cleaned up tarball: ${tarballName}`);

  // 7. Final summary.
  if (failures.length > 0) {
    process.stderr.write(`\n[verify-publish] ${failures.length} failure(s):\n`);
    for (const f of failures) {
      process.stderr.write(`  - ${f}\n`);
    }
    if (!KEEP_TMP && tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
    } else if (KEEP_TMP) {
      process.stderr.write(`[verify-publish] Temp dir preserved at ${tmpRoot} (--keep-tmp)\n`);
    }
    process.exit(1);
  }

  log('All assertions passed.');
  if (!KEEP_TMP) {
    rmSync(tmpRoot, { recursive: true, force: true });
    log('Temp dir cleaned up.');
  } else {
    log(`Temp dir preserved at ${tmpRoot} (--keep-tmp)`);
  }
  process.exit(0);
} catch (err) {
  process.stderr.write(`[verify-publish] FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  if (!KEEP_TMP && tmpRoot) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  } else if (KEEP_TMP && tmpRoot) {
    process.stderr.write(`[verify-publish] Temp dir preserved at ${tmpRoot} (--keep-tmp)\n`);
  }
  process.exit(1);
}
