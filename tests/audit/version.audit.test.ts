/**
 * AUDIT_TS_001 — Version drift detection across four sources.
 *
 * Sources:
 *   1. package.json.version
 *   2. MCP server `serverInfo.version` from an initialize round-trip
 *   3. npm registry (`npm view @codewiki/mcp version`) — handled as
 *      404/'not_published' OR a published version string
 *   4. Latest codewiki-mcp v2.7 plan Status header — expected VERIFIED
 *
 * Locks PSF-001 once Task 3 fixes the drift (server.ts derives from
 * package.json). Before Task 3 the equality assertion fails — that is
 * the audit's red signal.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';
import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { readPackageJson, readLatestPlanStatus, mkTempDirs } from './scenarios.js';

async function serverInfoVersion(projectDir: string, cacheDir: string): Promise<string> {
  const cache = await Cache.open({ dbPath: `${cacheDir}/cache.db` });
  const client = new CodeWikiClient(new PlaywrightDriver(), cache);
  // Stub the network so buildServer() doesn't kick the manifest watcher into
  // a Playwright bootstrap for this version-only probe.
  client.fetchPage = async () => ({ nodes: [], notFound: true, emptyShell: false, firstCommitSha: null });
  const built = await buildServer({ cwd: projectDir, cache, client });
  const [serverT, clientT] = InMemoryTransport.createLinkedPair();
  await built.server.connect(serverT);
  const mcpClient = new Client({ name: 'audit-client', version: '0.0.1' });
  await mcpClient.connect(clientT);
  // After initialize round-trip, the server-info version is on the negotiated
  // protocol — the MCP SDK exposes it via getServerVersion().
  const serverInfo = mcpClient.getServerVersion();
  await mcpClient.close();
  await built.server.close();
  cache.close();
  return serverInfo?.version ?? 'UNKNOWN';
}

describe('AUDIT_TS_001: Version drift detection across four sources', () => {
  it('package.json.version === MCP server serverInfo.version (PSF-001 lock)', async () => {
    const dirs = mkTempDirs('codewiki-audit-version');
    try {
      const pkg = readPackageJson();
      const srvVersion = await serverInfoVersion(dirs.projectDir, dirs.cacheDir);
      // PSF-001: this is the load-bearing equality. Pre-Task-3 it fails
      // (server.ts:87 had literal '0.2.1' vs package.json '0.1.0').
      expect(srvVersion).toBe(pkg.version);
    } finally {
      dirs.cleanup();
    }
  });

  it('npm registry version is X (published) OR not_published (informational)', () => {
    const pkg = readPackageJson();
    let registryVersion: string;
    try {
      registryVersion = execSync(`npm view ${pkg.name} version 2>/dev/null`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }).trim();
    } catch {
      registryVersion = 'not_published';
    }
    // Informational only — we don't auto-publish. We record the relationship
    // so the audit's findings inventory can surface drift to the user.
    if (registryVersion !== 'not_published') {
      // If published, it should not be ahead of the local version.
      // (We expect either equal or local-is-ahead-of-published.)
      const cmp = compareSemver(registryVersion, pkg.version);
      expect(cmp).toBeLessThanOrEqual(0);
    } else {
      expect(registryVersion).toBe('not_published');
    }
  });

  it('codewiki-mcp v2.7 plan Status === VERIFIED', () => {
    const planStatus = readLatestPlanStatus('codewiki-mcp-v2.7');
    expect(planStatus).not.toBeNull();
    expect(planStatus?.status).toBe('VERIFIED');
  });
});

function compareSemver(a: string, b: string): number {
  const parseSemver = (s: string) => s.split('.').map((n) => parseInt(n, 10));
  const [aMaj, aMin, aPat] = parseSemver(a);
  const [bMaj, bMin, bPat] = parseSemver(b);
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPat - bPat;
}
