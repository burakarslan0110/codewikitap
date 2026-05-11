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
import { getLogger } from './logging.js';
import { LOG_DIR, DISABLE_PREWARM } from './config.js';
import { Cache } from './services/cache.js';
import { VectorStore } from './services/vector_store.js';
import { EMBED_MODEL, EMBED_MODEL_DIM, LEGACY_EMBED_MODEL_DEFAULT } from './config_rag.js';
import { buildPrewarmer, type Prewarmer } from './services/prewarmer.js';

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

function runInstall(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // ⛔ MCP stdio reserves stdout for JSON-RPC frames. The installer's stdout
    // MUST be piped (or ignored) and forwarded to stderr — never inherited
    // (Codex finding: that corrupts the initialize handshake on first run).
    const child = spawn('npx', ['playwright', 'install', '--only-shell', 'chromium'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright install exited with code ${code}`));
    });
  });
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
  try {
    await ensurePlaywright();
  } catch (err) {
    log.error('playwright-bootstrap-failed', { reason: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  const cwd = process.cwd();

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
  const driver = getPlaywrightDriver();
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

  const transport = new StdioServerTransport();
  await built.server.connect(transport);
  log.info('server-ready', { tools: built.toolNames });
}

// Only run main() when this file is invoked as the bin entry — never as
// an import side-effect. embedder_autoreindex.test.ts imports
// `runEmbedderAutoReindex` from this module; without the guard, main()
// would also fire (Playwright bootstrap, manifest scan, stdio transport
// connect) during the test process and call process.exit(1) on failure.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
