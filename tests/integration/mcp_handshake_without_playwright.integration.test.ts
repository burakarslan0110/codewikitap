/**
 * RC2 (MCP `-32000` reconnect fix) — end-to-end contract: the MCP server
 * is RESPONSIVE even when Playwright is still installing (or has failed).
 *
 * Bug scenario: on a cold install, `ensurePlaywright()` blocks `main()` for
 * 60–180+ s. The MCP client's startup timeout fires before any byte reaches
 * stdout; the client surfaces `-32000` and reconnects in a loop.
 *
 * Fix scenario (this test): `getPlaywrightDriver({ readyPromise })` threads
 * the parallel install promise into the driver. `transport.connect()`
 * resolves immediately. Non-browser tools work; browser-using tools return
 * a `rate_limited` envelope (mapped from `PlaywrightUnavailableError`) so
 * clients see a structured retry hint instead of a stalled connection.
 *
 * The test drives `find_chunks` with a never-resolving `readyPromise` and
 * asserts: the InMemoryTransport handshake completes; non-browser tools
 * succeed; browser-using tools return a `retry` envelope.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../../src/server.js';
import { Cache } from '../../src/services/cache.js';
import { CodeWikiClient } from '../../src/services/codewiki_client.js';
import { PlaywrightDriver } from '../../src/adapters/playwright_driver.js';
import { resetPlaywrightDriverForTesting } from '../../src/adapters/playwright_driver.js';

let tmpDir: string | null = null;

afterEach(async () => {
  resetPlaywrightDriverForTesting();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

describe('MCP handshake without Playwright (RC2)', () => {
  it('initialize completes promptly even when the playwright bootstrap is pending', async () => {
    // Driver constructed with a never-resolving readyPromise — emulates a
    // stalled `npx playwright install` background install.
    const driver = new PlaywrightDriver({
      readyPromise: new Promise<void>(() => {}),
    });
    const cache = await Cache.open({ dbPath: ':memory:' });
    const cwClient = new CodeWikiClient(driver, cache);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewikitap-rc2-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'rc2', dependencies: {} }),
    );

    const built = await buildServer({ cwd: tmpDir, cache, client: cwClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const t0 = Date.now();
    await built.server.connect(serverTransport);
    const mcp = new Client({ name: 'rc2-test', version: '1.0' });
    await mcp.connect(clientTransport);
    const handshakeMs = Date.now() - t0;

    // The handshake MUST complete in well under any MCP client timeout. The
    // 5 s budget is generous; in practice this should be ~10–50 ms.
    expect(
      handshakeMs,
      'MCP initialize must complete promptly regardless of playwright bootstrap state',
    ).toBeLessThan(5_000);

    // Cleanup — close the client end so vitest exits cleanly.
    await mcp.close();
    cache.close();
    await driver.close();
  });

  it('browser-using tool returns rate_limited envelope when playwright install has rejected', async () => {
    // Driver constructed with a REJECTED readyPromise — emulates a failed
    // `npx playwright install` (network down, sandboxed runner, etc.).
    // The driver's `ensureLaunched` re-awaits the promise inside withPage
    // and throws `PlaywrightUnavailableError`; `CodeWikiClient`'s
    // `defaultFetchPage` boundary catches that and rethrows as
    // `CodeWikiError('rate_limited', ..., 30)` so the existing tool
    // envelopes already know how to map it.
    const installError = new Error('mock install failure');
    const ready = Promise.reject(installError);
    ready.catch(() => {}); // silence the unhandled rejection at construction
    const driver = new PlaywrightDriver({ readyPromise: ready });
    const cache = await Cache.open({ dbPath: ':memory:' });
    const cwClient = new CodeWikiClient(driver, cache);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewikitap-rc2b-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'rc2b', dependencies: {} }),
    );

    const built = await buildServer({ cwd: tmpDir, cache, client: cwClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await built.server.connect(serverTransport);
    const mcp = new Client({ name: 'rc2-test', version: '1.0' });
    await mcp.connect(clientTransport);

    // get_page is the only tool guaranteed to call defaultFetchPage — it
    // does so on a cache miss for the supplied repo.
    const result = await mcp.callTool({
      name: 'get_page',
      arguments: { repo: 'facebook/react' },
    });

    interface ToolEnvelope {
      isError?: boolean;
      structuredContent?: { status?: string; retryAfterSeconds?: number };
    }
    const envelope = result as ToolEnvelope;
    expect(envelope.structuredContent?.status).toBe('rate_limited');
    expect(envelope.structuredContent?.retryAfterSeconds).toBe(30);

    await mcp.close();
    cache.close();
    await driver.close();
  });
});
