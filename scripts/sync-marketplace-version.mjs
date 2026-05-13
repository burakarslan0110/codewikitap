#!/usr/bin/env node
/**
 * Sync version across the three manifest files. Single source of truth =
 * `package.json.version`. Runs at `prepack` so every `pnpm pack` /
 * `pnpm publish` emits a synced tarball. Idempotent — safe to re-run.
 *
 * Targets:
 *   - package.json.version              (read-only source)
 *   - .claude-plugin/marketplace.json   (version + plugins[0].version)
 *   - .claude-plugin/plugin.json        (version)
 *
 * Exit codes:
 *   0 — success (incl. no-op when already in sync)
 *   1 — filesystem or JSON parse error
 *   2 — invalid semver in package.json.version
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/;

const cwd = process.cwd();
const packagePath = join(cwd, 'package.json');
const marketplacePath = join(cwd, '.claude-plugin/marketplace.json');
const pluginPath = join(cwd, '.claude-plugin/plugin.json');

function log(msg) {
  process.stderr.write(`[sync-marketplace-version] ${msg}\n`);
}

function readRaw(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    log(`FATAL: cannot read ${path}: ${err.message}`);
    process.exit(1);
  }
}

function parseJson(raw, path) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    log(`FATAL: ${path} is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

function writeJsonIfChanged(path, originalRaw, obj) {
  const next = JSON.stringify(obj, null, 2) + '\n';
  if (next === originalRaw) return false;
  try {
    writeFileSync(path, next);
  } catch (err) {
    log(`FATAL: cannot write ${path}: ${err.message}`);
    process.exit(1);
  }
  return true;
}

const pkgRaw = readRaw(packagePath);
const pkg = parseJson(pkgRaw, packagePath);

const version = pkg.version;
if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
  log(`FATAL: invalid semver in package.json.version: ${JSON.stringify(version)}`);
  process.exit(2);
}

const marketplaceRaw = readRaw(marketplacePath);
const marketplace = parseJson(marketplaceRaw, marketplacePath);
marketplace.version = version;
if (Array.isArray(marketplace.plugins) && marketplace.plugins[0]) {
  marketplace.plugins[0].version = version;
}
const wroteMarketplace = writeJsonIfChanged(marketplacePath, marketplaceRaw, marketplace);

const pluginRaw = readRaw(pluginPath);
const plugin = parseJson(pluginRaw, pluginPath);
plugin.version = version;
const wrotePlugin = writeJsonIfChanged(pluginPath, pluginRaw, plugin);

if (wroteMarketplace || wrotePlugin) {
  log(`synced to v${version} (marketplace=${wroteMarketplace ? 'updated' : 'unchanged'}, plugin=${wrotePlugin ? 'updated' : 'unchanged'})`);
} else {
  log(`already in sync at v${version}`);
}
