/**
 * Heap-cap self-reexec wrapper.
 *
 * On 7.5 GB / 2 GB-swap hosts the Linux OOM-killer was SIGKILL'ing the MCP
 * server child under repeated `find_chunks` load (5 SIGKILL events / 15 min
 * observed in v0.6.1 test harness). The fix is to cap Node's old-space heap
 * via `--max-old-space-size=<MB>` — but we cannot rely on users to set the
 * flag themselves. The bin entry self-execs once at startup with the flag
 * prepended unless one of three escape hatches engages.
 *
 * Decision precedence (highest first):
 *   1. `CODEWIKI_HEAP_CAP_APPLIED=1` sentinel env var — set by the wrapper
 *      on the child. PRIMARY fork-bomb guard: an idempotency check on
 *      `execArgv` alone fails when a launcher (PM2, systemd unit override,
 *      container init wrapper) sanitizes `execArgv` between wrapper and
 *      child, which would cause every re-exec'd child to re-exec forever.
 *      Env vars are inherited by default; the sentinel survives.
 *   2. `CODEWIKI_DISABLE_HEAP_CAP=1` — operator opt-out.
 *   3. `--max-old-space-size` already present in execArgv — idempotency
 *      check for the common case where the user explicitly set the flag.
 *
 * stdio integrity: the wrapper passes `stdio: 'inherit'` so the MCP JSON-RPC
 * frames flow directly between client and the re-exec'd child. The wrapper
 * NEVER touches `process.stdout` — `codewikitap-stdio-integrity.md` invariant.
 *
 * Signal forwarding: the wrapper installs SIGTERM/SIGINT/SIGHUP handlers
 * that forward the signal to the child. Without forwarding, the child
 * holds the MCP stdio pipe open after a client disconnect → client sees
 * `-32000` (the exact failure mode being fixed).
 */

import { spawn, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process';

/**
 * IPC message shape used by the wrapper to ask the child to run its graceful
 * `closer()` on Windows (where `child.kill(sig)` is abrupt and the child's
 * `process.on('SIGTERM', ...)` handler never fires). Exported so the child
 * (src/index.ts) and tests can refer to the literal type.
 */
export interface HeapCapShutdownMessage {
  readonly type: 'codewiki-shutdown';
  readonly signal: NodeJS.Signals;
}

/** Type guard for `HeapCapShutdownMessage` on the receiving end (src/index.ts). */
export function isHeapCapShutdownMessage(msg: unknown): msg is HeapCapShutdownMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { type?: unknown; signal?: unknown };
  return m.type === 'codewiki-shutdown' && typeof m.signal === 'string';
}

export interface HeapCapDecisionInputs {
  readonly env: NodeJS.ProcessEnv;
  readonly execArgv: readonly string[];
}

export type HeapCapReason = 'sentinel' | 'disabled' | 'already-set' | 'needs-cap';

export interface HeapCapDecision {
  readonly reexec: boolean;
  readonly reason: HeapCapReason;
}

/**
 * Pure decision function — does the bin entry need to re-exec itself with
 * `--max-old-space-size=<MB>` prepended? See module docstring for precedence.
 */
export function shouldReexecForHeapCap(inputs: HeapCapDecisionInputs): HeapCapDecision {
  if (inputs.env.CODEWIKI_HEAP_CAP_APPLIED === '1') {
    return { reexec: false, reason: 'sentinel' };
  }
  if (inputs.env.CODEWIKI_DISABLE_HEAP_CAP === '1') {
    return { reexec: false, reason: 'disabled' };
  }
  if (hasMaxOldSpaceSize(inputs.execArgv)) {
    return { reexec: false, reason: 'already-set' };
  }
  return { reexec: true, reason: 'needs-cap' };
}

function hasMaxOldSpaceSize(execArgv: readonly string[]): boolean {
  return execArgv.some((arg) => arg === '--max-old-space-size' || arg.startsWith('--max-old-space-size='));
}

export interface HeapCapSpawnDeps {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly heapMb: number;
  readonly spawnImpl?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly onSignal?: (sig: NodeJS.Signals, handler: () => void) => void;
  readonly exitImpl?: (code: number) => never;
  /**
   * Test seam: override `process.platform` so the IPC-graceful-shutdown
   * branch is exercisable in unit tests on any host.
   */
  readonly platformOverride?: NodeJS.Platform;
  /**
   * Test seam: override the grace window the wrapper gives the child to
   * exit after sending the IPC shutdown message before force-killing.
   * Default 5000 ms.
   */
  readonly ipcGraceMs?: number;
}

/**
 * Spawn `process.execPath --max-old-space-size=<MB> ...execArgv <argv[1]> <...argv.slice(2)>`,
 * inherit stdio, set the sentinel env, forward signals, await the child,
 * exit with its code. Resolves never (calls `exitImpl` instead).
 *
 * Returns the spawned ChildProcess so tests (and the unlikely caller that
 * wants to defer the exit) can inspect it; production code at the bin
 * entry awaits the child's `exit` event via the returned handle.
 */
export function reexecWithHeapCap(deps: HeapCapSpawnDeps): ChildProcess {
  const spawnFn = deps.spawnImpl ?? spawn;
  const onSignal = deps.onSignal ?? ((sig, handler) => { process.on(sig, handler); });
  const exitFn = deps.exitImpl ?? ((code) => process.exit(code));

  const scriptPath = deps.argv[1];
  if (!scriptPath) {
    // Defensive: argv[1] is the script being run; absent means node was
    // launched as a REPL or eval and re-exec doesn't make sense. Bail.
    throw new Error('reexecWithHeapCap: process.argv[1] is undefined (REPL/eval mode)');
  }
  const scriptArgs = deps.argv.slice(2);
  const args: string[] = [
    `--max-old-space-size=${deps.heapMb}`,
    ...deps.execArgv,
    scriptPath,
    ...scriptArgs,
  ];

  // Windows lacks POSIX signal delivery — `child.kill('SIGTERM')` is abrupt
  // and the child's `process.on('SIGTERM', ...)` handler never fires. To
  // give Windows users a graceful path, the wrapper opens an IPC channel
  // (4th stdio fd) and sends a `codewiki-shutdown` message; the child's
  // `process.on('message', ...)` handler in src/index.ts runs `closer()`
  // cleanly. On POSIX, the IPC channel is unused — direct `child.kill(sig)`
  // is graceful and faster.
  const platform = deps.platformOverride ?? process.platform;
  const isWindows = platform === 'win32';
  const stdio: StdioOptions = isWindows
    ? ['inherit', 'inherit', 'inherit', 'ipc']
    : 'inherit';

  const child = spawnFn(deps.execPath, args, {
    stdio,
    env: { ...deps.env, CODEWIKI_HEAP_CAP_APPLIED: '1' },
  });

  // Grace period (ms) the wrapper waits for the child to exit after an IPC
  // shutdown message before force-killing. Exposed via deps for tests.
  const ipcGraceMs = deps.ipcGraceMs ?? 5_000;

  // Forward fatal signals so MCP client disconnects propagate cleanly to
  // the child. Without this the child holds the stdio pipe open → client
  // sees -32000. The handlers are best-effort; an EPERM on child.kill is
  // swallowed (the child may have already exited).
  //
  // SIGHUP doesn't exist on Windows — register on POSIX only.
  const signals: NodeJS.Signals[] = isWindows
    ? ['SIGTERM', 'SIGINT']
    : ['SIGTERM', 'SIGINT', 'SIGHUP'];

  for (const sig of signals) {
    onSignal(sig, () => {
      if (isWindows && typeof child.send === 'function') {
        // Windows: IPC message → child's closer(). Force-kill if the grace
        // period elapses.
        try {
          child.send({ type: 'codewiki-shutdown', signal: sig } satisfies HeapCapShutdownMessage);
        } catch {
          /* IPC channel closed — fall through to force-kill */
          try { child.kill(); } catch { /* */ }
          return;
        }
        const t = setTimeout(() => {
          try { child.kill(); } catch { /* */ }
        }, ipcGraceMs);
        // unref() so the timer never holds the wrapper alive past child exit.
        t.unref();
      } else {
        try {
          child.kill(sig);
        } catch {
          /* child already gone */
        }
      }
    });
  }

  child.on('exit', (code, signal) => {
    if (signal) {
      // Conventional "killed by signal" exit code: 128 + signal number.
      // We approximate via os.constants.signals when available; otherwise
      // a generic 130 (SIGINT) is the safest non-zero default.
      const sigNum = signalToExitCode(signal);
      exitFn(sigNum);
    } else {
      exitFn(code ?? 0);
    }
  });

  return child;
}

function signalToExitCode(signal: NodeJS.Signals): number {
  // Minimal table — only the signals we forward. Anything else falls back
  // to 128 + 15 (SIGTERM) which is a reasonable "killed" sentinel.
  switch (signal) {
    case 'SIGINT':
      return 130;
    case 'SIGHUP':
      return 129;
    case 'SIGTERM':
    default:
      return 143;
  }
}
