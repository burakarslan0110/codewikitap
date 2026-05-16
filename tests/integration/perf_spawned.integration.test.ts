/**
 * TS-007 spawned-child variant — per-PID RSS measurement via /proc.
 *
 * Spawns the real `dist/index.js` with three test-mode env vars that
 * short-circuit external dependencies (Playwright, the embedder model, the
 * reranker model) so the indexer's reset+rebuild loop runs in pure JS
 * inside a Node process the test runner doesn't share. RSS is then read
 * from `/proc/<child.pid>/status:VmRSS`, isolating server-only allocations
 * from test-runner overhead — the gap the InMemoryTransport variant cannot
 * close (Vitest+server RSS combined).
 *
 * Linux-only: `/proc/<pid>/status` is a Linux kernel interface. Skip on
 * macOS/Windows; the InMemoryTransport variant in `perf.integration.test.ts`
 * stays the cross-platform proxy.
 *
 * Production code paths exercised:
 *   - heap-cap re-exec (the wrapper IS the child we spawn)
 *   - CodeWikiClient.defaultFetchPage (fixture-dir branch)
 *   - Indexer.indexRepo single-flight + freshness check
 *   - VectorStore + GraphStore sqlite writes
 *
 * Production code paths bypassed (test seams, env-gated):
 *   - Playwright page.goto → `CODEWIKI_TEST_FIXTURE_DIR` reads JSON instead
 *   - Embedder.encode model load → `CODEWIKI_TEST_STUB_EMBEDDER=1` returns
 *     deterministic L2-normalized vectors
 *   - Reranker.score model load → `CODEWIKI_TEST_STUB_RERANKER=1` returns
 *     deterministic scores
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const DIST_ENTRY = path.resolve(__dirname, '../../dist/index.js');
const IS_LINUX = process.platform === 'linux';
const IS_CI = process.env.CI === 'true' || process.env.CI === '1';

interface SpawnedChild {
  proc: ChildProcess;
  pid: number;
  stderrBuf: { value: string };
  pendingRequests: Map<number, (resp: unknown) => void>;
}

function readVmRssKb(pid: number): number {
  const raw = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(raw);
  if (!m) throw new Error(`/proc/${pid}/status: VmRSS not found`);
  return Number.parseInt(m[1]!, 10);
}

async function spawnServer(env: NodeJS.ProcessEnv): Promise<SpawnedChild> {
  const proc = spawn(process.execPath, [DIST_ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!proc.pid) throw new Error('spawn returned no pid');

  const pendingRequests = new Map<number, (resp: unknown) => void>();
  const stderrBuf = { value: '' };
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf.value += chunk.toString('utf-8'); });

  let stdoutBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf-8');
    while (true) {
      const nl = stdoutBuf.indexOf('\n');
      if (nl < 0) break;
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as { id?: number };
        if (typeof obj.id === 'number') {
          const cb = pendingRequests.get(obj.id);
          if (cb) {
            pendingRequests.delete(obj.id);
            cb(obj);
          }
        }
      } catch {
        /* non-JSON line — ignore */
      }
    }
  });

  // Wait for server-ready stderr log.
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (stderrBuf.value.includes('"server-ready"')) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > 15_000) {
        clearInterval(t);
        reject(new Error(`server-ready timeout; stderr tail:\n${stderrBuf.value.slice(-1500)}`));
      }
    }, 50);
  });

  return { proc, pid: proc.pid, stderrBuf, pendingRequests };
}

let nextId = 1;
function rpcCall(child: SpawnedChild, method: string, params?: unknown): Promise<{ result?: unknown; error?: unknown }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    child.pendingRequests.set(id, (resp) => resolve(resp as { result?: unknown; error?: unknown }));
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';
    child.proc.stdin?.write(frame, (err) => { if (err) reject(err); });
    setTimeout(() => {
      if (child.pendingRequests.has(id)) {
        child.pendingRequests.delete(id);
        reject(new Error(`RPC timeout (id=${id}, method=${method})`));
      }
    }, 10_000);
  });
}

async function handshake(child: SpawnedChild): Promise<void> {
  await rpcCall(child, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'perf-spawned', version: '0' },
  });
  // notifications/initialized is one-way (no id).
  child.proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
}

async function shutdown(child: SpawnedChild): Promise<void> {
  try { child.proc.kill('SIGTERM'); } catch { /* */ }
  await new Promise((resolve) => {
    if (child.proc.exitCode !== null) return resolve(undefined);
    child.proc.on('exit', () => resolve(undefined));
    setTimeout(() => { try { child.proc.kill('SIGKILL'); } catch { /* */ } resolve(undefined); }, 3000);
  });
}

function writeFixture(dir: string, repo: string, commitSha: string): void {
  const sectionSlugs = ['overview', 'api', 'transactions', 'pragmas', 'prepared', 'iterators'];
  const nodes = sectionSlugs.flatMap((s) => [
    {
      type: 'heading' as const,
      sectionSlug: s,
      slug: s,
      title: `${s} title`,
      level: 1 as const,
      parentSlug: null,
      hasDiagrams: false,
    },
    {
      type: 'prose' as const,
      sectionSlug: s,
      markdown:
        `Documentation for ${s}. Covers semantics, gotchas, and recommended patterns. ` +
        `Refer to the API reference for full type signatures. Errors carry a structured code. ` +
        `Performance notes: prefer batched operations to minimize transaction overhead.`,
    },
  ]);
  const extraction = {
    nodes,
    notFound: false,
    emptyShell: false,
    firstCommitSha: commitSha,
  };
  const file = path.join(dir, `${repo.replace(/\//g, '__')}.json`);
  fs.writeFileSync(file, JSON.stringify(extraction), 'utf-8');
}

describe.skipIf(!IS_LINUX)('TS-007 spawned-child + /proc VmRSS', () => {
  let fixtureDir: string;
  let cacheDir: string;
  let stateDir: string;
  let child: SpawnedChild;

  beforeAll(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-perf-spawn-fix-'));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-perf-spawn-cache-'));
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-perf-spawn-state-'));

    // Pre-write fixtures for 12 distinct repos (1 pre-warm + 10 cycle + 1 spare).
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    writeFixture(fixtureDir, 'prewarm/repo', sha);
    for (let i = 0; i < 11; i++) writeFixture(fixtureDir, `cycle/repo-${i}`, sha);

    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error('dist/index.js missing; run `pnpm build` before this test');
    }

    child = await spawnServer({
      CODEWIKI_TEST_FIXTURE_DIR: fixtureDir,
      CODEWIKI_TEST_STUB_EMBEDDER: '1',
      CODEWIKI_TEST_STUB_RERANKER: '1',
      CODEWIKI_DISABLE_KG: '1',
      CODEWIKI_DISABLE_MODEL_WARMUP: '1',
      CODEWIKI_DISABLE_HEARTBEAT: '1',
      CODEWIKI_DISABLE_WATCH: '1',
      XDG_CACHE_HOME: cacheDir,
      XDG_STATE_HOME: stateDir,
    });
    await handshake(child);
  }, 30_000);

  afterAll(async () => {
    if (child) await shutdown(child);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('pre-warm via prepareOnly returns ready with chunkCount > 0', async () => {
    const r = await rpcCall(child, 'tools/call', {
      name: 'get_page',
      arguments: { repo: 'prewarm/repo', prepareOnly: true },
    });
    const sc = ((r.result as { structuredContent?: { status?: string; chunkCount?: number } })?.structuredContent) ?? {};
    expect(sc.status).toBe('ready');
    expect((sc.chunkCount ?? 0)).toBeGreaterThan(0);
  }, 15_000);

  it.skipIf(IS_CI)('10× rebuild cycles: VmRSS delta ≤ 50 MB (local stress, skipped on CI)', async () => {
    // Baseline AFTER pre-warm so V8 has stabilized.
    const baselineKb = readVmRssKb(child.pid);

    for (let i = 0; i < 10; i++) {
      const r = await rpcCall(child, 'tools/call', {
        name: 'get_page',
        arguments: { repo: `cycle/repo-${i}`, prepareOnly: true },
      });
      const sc = ((r.result as { structuredContent?: { status?: string } })?.structuredContent) ?? {};
      expect(sc.status, `cycle ${i}: status`).toBe('ready');
    }

    const finalKb = readVmRssKb(child.pid);
    const deltaMb = (finalKb - baselineKb) / 1024;
    // Per-PID measurement isolates server allocations. A 50 MB ceiling is
    // tight enough to flag a real leak; V8 fragmentation + GC noise stays
    // well under this on the synthetic fixture.
    expect(deltaMb, `VmRSS delta after 10 rebuilds: baseline=${baselineKb}KB final=${finalKb}KB delta=${deltaMb.toFixed(1)}MB`).toBeLessThan(50);
  }, 30_000);

  it('child process did not restart during the test', () => {
    expect(child.proc.exitCode).toBeNull();
    expect(child.proc.signalCode).toBeNull();
  });
});
