#!/usr/bin/env node
/**
 * Bin entry point. Boots the MCP server on stdio.
 *
 * On first run, ensures Playwright's chromium-headless-shell is actually
 * launchable (not just resolvable — `executablePath()` lies when the binary
 * is missing, per the Codex spec-review finding).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildServer } from './server.js';
import { getPlaywrightDriver } from './adapters/playwright_driver.js';
import { installStdoutTripwire } from './adapters/stdout_guard.js';
import { getLogger, type Logger } from './logging.js';
import {
  LOG_DIR,
  DISABLE_PREWARM,
  DISABLE_MODEL_WARMUP,
  STDOUT_TRIPWIRE,
  PLAYWRIGHT_INSTALL_TIMEOUT_MS,
} from './config.js';
import { Cache } from './services/cache.js';
import { VectorStore } from './services/vector_store.js';
import { EMBED_MODEL, EMBED_MODEL_DIM, LEGACY_EMBED_MODEL_DEFAULT } from './config_rag.js';
import { buildPrewarmer, type Prewarmer } from './services/prewarmer.js';
import type { Embedder } from './adapters/embedder.js';
import type { Reranker } from './adapters/reranker.js';

const SENTINEL_PATH = path.join(LOG_DIR, '.playwright-ok');

interface PlaywrightSentinel { execPath: string; mtimeMs: number }

function readSentinel(): PlaywrightSentinel | null {
  try {
    const raw = fs.readFileSync(SENTINEL_PATH, 'utf8');
    const parsed = JSON.parse(raw) as PlaywrightSentinel;
    if (typeof parsed.execPath === 'string' && typeof parsed.mtimeMs === 'number') return parsed;
  } catch { /* missing or corrupt — re-probe */ }
  return null;
}

function writeSentinel(execPath: string, mtimeMs: number): void {
  try {
    fs.mkdirSync(path.dirname(SENTINEL_PATH), { recursive: true });
    fs.writeFileSync(SENTINEL_PATH, JSON.stringify({ execPath, mtimeMs }), 'utf8');
  } catch { /* best-effort — non-fatal */ }
}

async function ensurePlaywright(): Promise<void> {
  const log = getLogger();
  const { chromium } = await import('playwright');

  // Fast path: previous-run sentinel matches current binary mtime → skip
  // the launch probe (saves 1-3s on every cold start). Falls back to the
  // launch probe on any sentinel I/O error.
  const sentinel = readSentinel();
  if (sentinel) {
    try {
      const stat = fs.statSync(sentinel.execPath);
      if (stat.mtimeMs === sentinel.mtimeMs) {
        log.info('playwright-sentinel-hit');
        return;
      }
    } catch { /* fall through to launch probe */ }
  }

  // Codex finding fix: `executablePath()` returns the EXPECTED path even
  // when the binary is missing — the only honest probe is an actual launch.
  try {
    const browser = await chromium.launch({ channel: 'chromium-headless-shell' });
    await browser.close();
    const execPath = chromium.executablePath();
    if (execPath) {
      try {
        const stat = fs.statSync(execPath);
        writeSentinel(execPath, stat.mtimeMs);
      } catch { /* non-fatal */ }
    }
    log.info('playwright-ready');
    return;
  } catch (err) {
    log.warn('playwright-launch-probe-failed', { reason: err instanceof Error ? err.message : String(err) });
  }
  log.info('playwright-installing-headless-shell');
  await runInstall();
  // Re-verify with a second launch — install must be effective.
  const browser = await chromium.launch({ channel: 'chromium-headless-shell' });
  await browser.close();
  const execPath = chromium.executablePath();
  if (execPath) {
    try {
      const stat = fs.statSync(execPath);
      writeSentinel(execPath, stat.mtimeMs);
    } catch { /* non-fatal */ }
  }
  log.info('playwright-ready-after-install');
}

/**
 * Spawns `npx playwright install --only-shell chromium`.
 *
 * RC2 defense L7: bounded by a wallclock timeout (default 180000 ms, env
 * `CODEWIKI_PLAYWRIGHT_INSTALL_TIMEOUT_MS`). On overrun, the child is
 * killed with SIGTERM and the promise rejects with a clear error. Without
 * this, a stalled npm fetch could leave the install promise pending
 * indefinitely; the parallel-bootstrap fix in `main()` would then surface
 * `playwright_unavailable` retry envelopes forever instead of failing
 * fast with an actionable diagnostic.
 *
 * The child's stdio is `['ignore', 'pipe', 'inherit']`: stdin ignored,
 * stdout PIPED then forwarded to our stderr, stderr inherited (the parent
 * process's stderr). stdout is NEVER inherited — the MCP stdio protocol
 * reserves it for JSON-RPC frames (Codex finding: 'inherit' on stdout
 * corrupts the initialize handshake on first run).
 */
export function runInstall(timeoutMs: number = PLAYWRIGHT_INSTALL_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'install', '--only-shell', 'chromium'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer: NodeJS.Timeout = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* child may already be dead */
      }
      settle(() => reject(new Error(`playwright install timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('exit', (code) => {
      if (code === 0) settle(resolve);
      else settle(() => reject(new Error(`playwright install exited with code ${code}`)));
    });
  });
}

/**
 * MCP `-32000` reconnect fix (RC1 defense L3):
 *
 * Background warmup of the embedder + reranker after `transport.connect()`
 * has resolved. Called WITHOUT `await` from `main()` — its only side effect
 * is loading the @xenova/transformers models on disk so the first user
 * `find_chunks` / `find_neighbors` call does not eat the cold-load latency.
 *
 * Both legs are wrapped in try/catch and never throw out to the caller.
 * Failures surface as a single `warmup_failed` warn-log; the cold load
 * runs later from the tool handler.
 *
 * Skipped entirely when `CODEWIKI_DISABLE_MODEL_WARMUP=1`.
 */
export async function warmupModels(deps: {
  embedder: Embedder;
  reranker: Reranker;
  log: Logger;
}): Promise<void> {
  const { embedder, reranker, log } = deps;
  if (DISABLE_MODEL_WARMUP) {
    log.info('warmup_skipped', { reason: 'CODEWIKI_DISABLE_MODEL_WARMUP' });
    return;
  }
  log.info('warmup.embedder.started');
  try {
    await embedder.encode(['__codewikitap_warmup__']);
    log.info('warmup.embedder.done');
  } catch (err) {
    log.warn('warmup_failed', {
      model: 'embedder',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  log.info('warmup.reranker.started');
  try {
    await reranker.score('__codewikitap_warmup__', ['__codewikitap_warmup__']);
    log.info('warmup.reranker.done');
  } catch (err) {
    log.warn('warmup_failed', {
      model: 'reranker',
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * v2.5: detect embedder model swap at startup. Three branches:
 *   (1) non-null fingerprint mismatch → drop chunks, log, stamp current
 *   (2) null fingerprint + populated index → synthesize legacy default,
 *       run mismatch detection (Codex critical fix #1 for legacy v2.4 DBs
 *       that have populated chunks but no fingerprint column)
 *   (3) null fingerprint + empty index → no-op (genuine fresh install)
 *
 * Pure-helper variant: accepts an opened cache + current config so tests
 * can pre-seed the cache and assert post-state directly. The cache is NOT
 * closed here (caller's responsibility).
 *
 * Exported for unit testing.
 */
export function applyEmbedderAutoReindex(
  cache: Cache,
  current: { model: string; dim: number },
): void {
  const log = getLogger();
  const store = new VectorStore(cache);
  const persisted = cache.getEmbedderFingerprint();

  let effectiveOld: { model: string; dim: number } | null = persisted;
  if (persisted === null) {
    if (store.hasAnyIndex()) {
      effectiveOld = {
        model: LEGACY_EMBED_MODEL_DEFAULT.model,
        dim: LEGACY_EMBED_MODEL_DEFAULT.dim,
      };
    }
  }
  if (effectiveOld === null) {
    return;
  }
  if (effectiveOld.model === current.model && effectiveOld.dim === current.dim) {
    if (persisted === null) {
      cache.setEmbedderFingerprint(current.model, current.dim);
    }
    return;
  }
  log.warn('model_swap_drop', { old: effectiveOld, new: current });
  // v2.6: when the dim ALSO changed, pass recreateVecChunksDim so
  // dropAllChunks DROPs + re-CREATEs the vec_chunks virtual table with the
  // new dim. Without this, the old vec0(float[<oldDim>]) schema would
  // reject inserts at the new dim and corrupt the auto-reindex contract.
  if (effectiveOld.dim !== current.dim) {
    store.dropAllChunks({ recreateVecChunksDim: current.dim });
  } else {
    store.dropAllChunks();
  }
  cache.setEmbedderFingerprint(current.model, current.dim);
}

/**
 * Bin-entry wrapper: opens the default cache, runs the auto-reindex,
 * closes. Called once at startup before buildServer.
 */
export async function runEmbedderAutoReindex(): Promise<void> {
  const cache = await Cache.open();
  try {
    applyEmbedderAutoReindex(cache, { model: EMBED_MODEL, dim: EMBED_MODEL_DIM });
  } finally {
    cache.close();
  }
}

async function main(): Promise<void> {
  const log = getLogger();
  const cwd = process.cwd();

  // RC2 (MCP -32000 fix): launch Playwright bootstrap IN PARALLEL with the
  // rest of startup. The promise is passed into `getPlaywrightDriver` so
  // `driver.withPage` (called by the tool handlers) gates its
  // `chromium.launch` on it. The MCP `initialize` handshake reaches the
  // wire within milliseconds of process start regardless of Playwright
  // state — clients no longer time out with `-32000` on cold installs.
  //
  // The catch handler swallows rejections so an unobserved
  // `playwrightReady.catch(...)` does not become an unhandled rejection.
  // The driver re-awaits the promise inside `ensureLaunched` and surfaces
  // `PlaywrightUnavailableError` from `withPage`; the `CodeWikiClient`
  // boundary remaps that to a `rate_limited` envelope.
  const playwrightReady: Promise<void> = ensurePlaywright().catch((err) => {
    log.error('playwright-bootstrap-failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  });

  // RC1 defense L4: install the side-observe stdout tripwire BEFORE
  // `transport.connect()` so any non-JSON-RPC byte written during boot is
  // captured. Off by default — only engaged via `CODEWIKI_STDOUT_TRIPWIRE=1`.
  if (STDOUT_TRIPWIRE) {
    installStdoutTripwire(log);
    log.info('stdout_tripwire_installed');
  }

  // v2.5: embedder model-swap auto-reindex. Runs BEFORE buildServer so the
  // first MCP request always sees a clean post-swap state. Three branches:
  //  (1) non-null fingerprint mismatch → drop chunks, log model_swap_drop,
  //      stamp current fingerprint
  //  (2) null fingerprint + populated index (legacy v2.4 DB, no fingerprint
  //      column ever existed) → synthesize LEGACY_EMBED_MODEL_DEFAULT and
  //      run mismatch detection (Codex critical fix #1)
  //  (3) null fingerprint + empty index (genuine fresh install) → no-op
  await runEmbedderAutoReindex();

  const built = await buildServer({ cwd });

  // RC2 (MCP -32000 fix): wire the parallel `playwrightReady` promise into
  // the driver singleton BEFORE any tool call could land. `withPage` awaits
  // the promise inside `ensureLaunched` and surfaces
  // `PlaywrightUnavailableError` on rejection; the `CodeWikiClient`
  // boundary remaps that to `rate_limited`.
  const driver = getPlaywrightDriver(playwrightReady);

  // RC2 (MCP -32000 fix): construct and connect the stdio transport BEFORE
  // any background work begins. `transport.start()` is trivial — it just
  // attaches a stdin listener — so the MCP `initialize` handshake reaches
  // the wire within milliseconds of process start regardless of Playwright
  // install state.
  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  log.info('server-ready', { tools: built.toolNames });

  // RC1 defense L3: kick off model warmup in background AFTER the handshake
  // has been advertised. The wrap that used to corrupt JSON-RPC frames is
  // gone, so warmup is purely a perf optimization (avoids cold-load latency
  // on the first user `find_chunks`). Failures emit a warn-log only.
  void warmupModels({ embedder: built.embedder, reranker: built.reranker, log });

  // v2.8: scanProject() is hoisted out of the watcher block so the prewarmer
  // works independently of CODEWIKI_DISABLE_WATCH (Codex review iter 1 #3).
  // A single initialScan feeds BOTH the watcher (when enabled) AND the
  // prewarmer (when enabled).
  const path = await import('node:path');
  const { DISABLE_MANIFEST_WATCH } = await import('./config.js');
  const { scanProject } = await import('./services/project_scanner.js');
  const { ManifestWatcher } = await import('./services/manifest_watcher.js');

  let initialScan: ReturnType<typeof scanProject> | null = null;
  try {
    initialScan = scanProject(cwd);
  } catch (err) {
    log.warn('initial_scan_failed', { err: err instanceof Error ? err.message : String(err) });
  }

  // v2.8: startup auto-prewarm. Constructed FIRST so the watcher's
  // onDepsAdded callback can forward additions into the queue. Eager-indexes
  // hasWiki=true direct deps so user queries arriving after a repo has been
  // prewarmed hit the freshness short-circuit instead of the 5 s retriever
  // race. Independent from the watcher knob — DISABLE_WATCH does NOT disable
  // prewarm.
  let prewarmer: Prewarmer | null = null;
  if (!DISABLE_PREWARM && initialScan && initialScan.dependencies.length > 0) {
    prewarmer = buildPrewarmer({
      client: built.client,
      indexer: built.indexer,
      cache: built.cache,
    });
    prewarmer.enqueueDeps(initialScan.dependencies);
    prewarmer.start();
    log.info('prewarmer_started', { queued: initialScan.dependencies.length });
  } else if (DISABLE_PREWARM) {
    log.info('prewarm_disabled');
  }

  // v2.2: optional manifest file-watcher. Enabled by default; opt-out via
  // CODEWIKI_DISABLE_WATCH=1. v2.8: wires onDepsAdded → prewarmer.enqueueDeps
  // so deps added mid-session prewarm without a server restart.
  let watcher: InstanceType<typeof ManifestWatcher> | null = null;
  if (!DISABLE_MANIFEST_WATCH && initialScan && initialScan.projectRoot && initialScan.manifestType) {
    try {
      // v2.3: prefer the scanner's matchedManifestPath when set (csproj
      // glob, nested gradle catalog); fall back to basename join for v1/v2/
      // v2.2 manifest types.
      const manifestPath =
        initialScan.matchedManifestPath ??
        path.join(initialScan.projectRoot, initialScan.manifestType);
      watcher = new ManifestWatcher({
        projectRoot: initialScan.projectRoot,
        manifestPath,
        workspaceMembers: initialScan.workspaceMembers,
        extraManifestFiles: initialScan.extraManifestFiles,
        cache: built.cache,
        scannerOpts: {},
        initialScan,
        // Only wire the callback when the prewarmer is active — keeps v2.7
        // lazy-probe behavior intact under CODEWIKI_DISABLE_PREWARM=1.
        ...(prewarmer ? { onDepsAdded: (added): void => prewarmer!.enqueueDeps(added) } : {}),
      });
      watcher.start();
      log.info('manifest_watcher_started', { manifestPath });
    } catch (err) {
      log.warn('manifest_watcher_init_failed', { err: err instanceof Error ? err.message : String(err) });
    }
  } else if (DISABLE_MANIFEST_WATCH) {
    log.info('manifest_watcher_disabled');
  }

  // v2.8: sequential shutdown. The previous Promise.all shape ran
  // driver.close() and cache.close() concurrently with watcher.stop(), so an
  // in-flight Indexer transaction could be raced by cache teardown
  // (Claude review iter 1 must_fix + Codex review iter 1 #1). Strict order:
  // prewarmer.stop drains the bg worker → watcher.stop closes chokidar →
  // driver.close releases Playwright pages → cache.close (sync) tears down
  // SQLite last, against a quiescent handle.
  const closer = async (signal: string): Promise<void> => {
    log.info('shutting-down', { signal });
    try {
      if (prewarmer) await prewarmer.stop();
      if (watcher) await watcher.stop();
      await driver.close();
      built.cache.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => { void closer('SIGINT'); });
  process.on('SIGTERM', () => { void closer('SIGTERM'); });
}

// Only run main() when this file is invoked as the bin entry — never as
// an import side-effect. embedder_autoreindex.test.ts imports
// `runEmbedderAutoReindex` from this module; without the guard, main()
// would also fire (Playwright bootstrap, manifest scan, stdio transport
// connect) during the test process and call process.exit(1) on failure.
//
// Resolve symlinks before comparing: npx symlinks the bin via
// node_modules/.bin/codewikitap, and on macOS /tmp itself is a symlink to
// /private/tmp. Without realpathSync, a direct string compare against
// import.meta.url (which is always the real path) is false negative and
// the bin silently no-ops on `npx codewikitap install` invocations.
function isBinEntry(): boolean {
  if (!process.argv[1]) return false;
  const metaPath = fileURLToPath(import.meta.url);
  if (metaPath === process.argv[1]) return true;
  try {
    return metaPath === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isBinEntry()) {
  if (process.argv[2] === 'install') {
    import('./installer/cli.js').then((m) => m.runInstallerCli(process.argv.slice(3))).then(() => process.exit(0)).catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
  } else {
    main().catch((err) => {
      process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
  }
}
