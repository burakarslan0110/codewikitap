/**
 * Marketplace version sync invariant (Madde 3 of marketplace-expansion plan).
 *
 * `scripts/sync-marketplace-version.mjs` runs at `prepack` and writes
 * `package.json.version` into three target fields. This test catches drift
 * even if the prepack hook never fires (mutation tester, manual edits).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../..');
const PACKAGE_JSON = join(REPO_ROOT, 'package.json');
const MARKETPLACE_JSON = join(REPO_ROOT, '.claude-plugin/marketplace.json');
const PLUGIN_JSON = join(REPO_ROOT, '.claude-plugin/plugin.json');
const SYNC_SCRIPT = join(REPO_ROOT, 'scripts/sync-marketplace-version.mjs');

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('marketplace version sync invariant', () => {
  it('package.json.version, marketplace.json.version, marketplace.json.plugins[0].version, plugin.json.version all match', () => {
    const pkg = readJson(PACKAGE_JSON);
    const marketplace = readJson(MARKETPLACE_JSON);
    const plugin = readJson(PLUGIN_JSON);

    const pkgVersion = pkg.version as string;
    const marketplaceVersion = marketplace.version as string;
    const plugins = marketplace.plugins as Array<Record<string, unknown>>;
    const pluginEntryVersion = plugins[0].version as string;
    const pluginManifestVersion = plugin.version as string;

    expect(marketplaceVersion, '.claude-plugin/marketplace.json `version` drifted from package.json').toBe(pkgVersion);
    expect(
      pluginEntryVersion,
      '.claude-plugin/marketplace.json `plugins[0].version` drifted from package.json — run `node scripts/sync-marketplace-version.mjs`'
    ).toBe(pkgVersion);
    expect(pluginManifestVersion, '.claude-plugin/plugin.json `version` drifted from package.json').toBe(pkgVersion);
  });
});

describe('sync-marketplace-version.mjs script behavior', () => {
  it('rejects malformed package.json.version (empty string) with non-zero exit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cwt-sync-test-'));
    try {
      const fakePackage = { name: 'codewikitap', version: '' };
      const fakeMarketplace = { version: '0.0.0', plugins: [{ version: '0.0.0' }] };
      const fakePlugin = { version: '0.0.0' };

      writeFileSync(join(tmp, 'package.json'), JSON.stringify(fakePackage, null, 2) + '\n');
      const fakePluginDir = join(tmp, '.claude-plugin');
      mkdirSync(fakePluginDir, { recursive: true });
      writeFileSync(join(fakePluginDir, 'marketplace.json'), JSON.stringify(fakeMarketplace, null, 2) + '\n');
      writeFileSync(join(fakePluginDir, 'plugin.json'), JSON.stringify(fakePlugin, null, 2) + '\n');

      let threw = false;
      let stderr = '';
      try {
        execFileSync('node', [SYNC_SCRIPT], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        threw = true;
        const e = err as { stderr?: Buffer; status?: number };
        stderr = e.stderr?.toString('utf8') ?? '';
      }

      expect(threw, 'script should exit non-zero on empty version').toBe(true);
      expect(stderr).toMatch(/invalid semver|version/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is idempotent — running twice produces zero file changes the second time', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cwt-sync-test-'));
    try {
      const pkg = { name: 'codewikitap', version: '1.2.3' };
      const marketplace = {
        version: '0.0.0',
        plugins: [{ version: '0.0.0', other: 'preserved' }],
        owner: { name: 'preserved' },
      };
      const plugin = { version: '0.0.0', name: 'preserved' };

      writeFileSync(join(tmp, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
      mkdirSync(join(tmp, '.claude-plugin'), { recursive: true });
      writeFileSync(join(tmp, '.claude-plugin/marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
      writeFileSync(join(tmp, '.claude-plugin/plugin.json'), JSON.stringify(plugin, null, 2) + '\n');

      execFileSync('node', [SYNC_SCRIPT], { cwd: tmp, stdio: 'ignore' });
      const afterFirst = readFileSync(join(tmp, '.claude-plugin/marketplace.json'), 'utf8');

      execFileSync('node', [SYNC_SCRIPT], { cwd: tmp, stdio: 'ignore' });
      const afterSecond = readFileSync(join(tmp, '.claude-plugin/marketplace.json'), 'utf8');

      expect(afterSecond, 'second run must be a no-op').toBe(afterFirst);

      const synced = JSON.parse(afterFirst) as Record<string, unknown>;
      expect(synced.version).toBe('1.2.3');
      const plugins = synced.plugins as Array<Record<string, unknown>>;
      expect(plugins[0].version).toBe('1.2.3');
      expect(plugins[0].other, 'unrelated keys preserved').toBe('preserved');
      expect(synced.owner, 'top-level keys preserved').toEqual({ name: 'preserved' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
