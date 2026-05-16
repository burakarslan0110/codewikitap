/**
 * TS-003 (Heap-cap re-exec) end-to-end verification.
 *
 * Each scenario spawns `dist/index.js` directly, parses the `runtime.execArgv`
 * info log line emitted in `src/index.ts:325`, and asserts the heap-cap
 * wrapper landed (or skipped) the flag per the spec.
 *
 * Cold start with `CODEWIKI_DISABLE_MODEL_WARMUP=1` + `CODEWIKI_DISABLE_KG=1`
 * keeps each spawn under ~2 s; the integration project's default timeout
 * gives ample headroom.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { describe, it, expect, beforeAll } from 'vitest';

const DIST_ENTRY = path.resolve(__dirname, '../../dist/index.js');

function distExists(): boolean {
  return fs.existsSync(DIST_ENTRY);
}

interface SpawnOutcome {
  stderr: string;
  stdout: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  execArgv: string[] | null;
  serverReady: boolean;
}

async function spawnAndCollect(opts: {
  env?: NodeJS.ProcessEnv;
  nodeArgs?: string[];
  timeoutMs?: number;
}): Promise<SpawnOutcome> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CODEWIKI_DISABLE_KG: '1',
    CODEWIKI_DISABLE_MODEL_WARMUP: '1',
  };
  const env: NodeJS.ProcessEnv = { ...baseEnv, ...(opts.env ?? {}) };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), DIST_ENTRY], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    let stdoutBuf = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf-8'); });
    child.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf-8'); });

    const sigtermTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* */ }
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(sigtermTimer);
      // Extract execArgv from runtime.execArgv log line.
      let execArgv: string[] | null = null;
      let serverReady = false;
      for (const line of stderrBuf.split('\n')) {
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as { msg?: string; execArgv?: string[] };
          if (obj.msg === 'runtime.execArgv' && Array.isArray(obj.execArgv)) {
            execArgv = obj.execArgv;
          }
          if (obj.msg === 'server-ready') {
            serverReady = true;
          }
        } catch {
          /* non-JSON line — skip */
        }
      }
      resolve({
        stderr: stderrBuf,
        stdout: stdoutBuf,
        exitCode: code,
        signal,
        execArgv,
        serverReady,
      });
    });
  });
}

describe('TS-003 — heap-cap re-exec', () => {
  beforeAll(() => {
    if (!distExists()) {
      throw new Error(`dist/index.js is missing; run \`pnpm build\` before tests/integration/heap_cap.integration.test.ts`);
    }
  });

  it('TS-003 Step 1: no flag → re-execs with --max-old-space-size=1536', async () => {
    const r = await spawnAndCollect({});
    expect(r.serverReady, `server-ready missing; stderr:\n${r.stderr.slice(-1500)}`).toBe(true);
    expect(r.execArgv, 'runtime.execArgv log line missing').not.toBeNull();
    expect(r.execArgv!).toContain('--max-old-space-size=1536');
    expect(r.stdout.length).toBe(0); // stdio integrity: nothing on stdout from the wrapper
  }, 15_000);

  it('TS-003 Step 2: --max-old-space-size=2048 in argv → NO re-exec (idempotent)', async () => {
    const r = await spawnAndCollect({ nodeArgs: ['--max-old-space-size=2048'] });
    expect(r.serverReady).toBe(true);
    expect(r.execArgv).not.toBeNull();
    // Idempotency check: the cap stays at 2048, the wrapper did not prepend 1536.
    expect(r.execArgv!).toContain('--max-old-space-size=2048');
    expect(r.execArgv!.filter((a) => a.startsWith('--max-old-space-size')).length).toBe(1);
  }, 15_000);

  it('TS-003 Step 3: CODEWIKI_DISABLE_HEAP_CAP=1 → NO re-exec (opt-out)', async () => {
    const r = await spawnAndCollect({ env: { CODEWIKI_DISABLE_HEAP_CAP: '1' } });
    expect(r.serverReady).toBe(true);
    expect(r.execArgv).not.toBeNull();
    expect(r.execArgv!.some((a) => a.startsWith('--max-old-space-size'))).toBe(false);
  }, 15_000);

  it('TS-003 Step 4: CODEWIKI_NODE_HEAP_MB=2048 → re-execs with 2048', async () => {
    const r = await spawnAndCollect({ env: { CODEWIKI_NODE_HEAP_MB: '2048' } });
    expect(r.serverReady).toBe(true);
    expect(r.execArgv).not.toBeNull();
    expect(r.execArgv!).toContain('--max-old-space-size=2048');
  }, 15_000);

  it('TS-003 Step 5: CODEWIKI_HEAP_CAP_APPLIED=1 → NO re-exec (fork-bomb guard)', async () => {
    const r = await spawnAndCollect({ env: { CODEWIKI_HEAP_CAP_APPLIED: '1' } });
    expect(r.serverReady).toBe(true);
    expect(r.execArgv).not.toBeNull();
    // Sentinel beats the absent-flag condition; no re-exec; no flag added.
    expect(r.execArgv!.some((a) => a.startsWith('--max-old-space-size'))).toBe(false);
  }, 15_000);

  it('TS-003 Step 6: SIGTERM to wrapper PID forwards to child (clean shutdown)', async () => {
    // SIGTERM from the test's timeout lands on the wrapper PID. The wrapper
    // forwards it to the child via child.kill('SIGTERM'). The child's
    // `process.on('SIGTERM', () => closer('SIGTERM'))` handler runs and
    // emits the `shutting-down` log before calling `process.exit(0)`.
    // The wrapper then sees `code=0, signal=null` and exits with 0.
    //
    // `shutting-down` is emitted ONLY by the child's closer() — never by
    // the wrapper. Its presence is the authoritative proof that the
    // wrapper forwarded the signal.
    const r = await spawnAndCollect({ timeoutMs: 4000 });
    expect(r.stderr).toMatch(/"msg":"shutting-down","signal":"SIGTERM"/);
    // Graceful exit through closer(): code 0, no killing signal at the
    // wrapper level. (If the wrapper had killed the child directly without
    // letting closer run, the child would have exited via signal and the
    // wrapper would have translated to 143.)
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
  }, 15_000);
});
