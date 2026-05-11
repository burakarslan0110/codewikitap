/**
 * Env-derived configuration. Imported once; values are immutable for the
 * lifetime of the process. Tests that need different values import the
 * defaults and pass overrides explicitly.
 */

import * as path from 'node:path';
import * as os from 'node:os';

function envString(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envBool(name: string): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

function xdgCacheHome(): string {
  return envString('XDG_CACHE_HOME', path.join(os.homedir(), '.cache'));
}

function xdgStateHome(): string {
  return envString('XDG_STATE_HOME', path.join(os.homedir(), '.local', 'state'));
}

export const CACHE_DIR = path.join(xdgCacheHome(), 'codewiki-mcp');
export const CACHE_DB_PATH = path.join(CACHE_DIR, 'cache.db');
export const LOG_DIR = path.join(xdgStateHome(), 'codewiki-mcp');
export const LOG_FILE_PATH = path.join(LOG_DIR, 'server.log');

export const LOG_LEVEL = envString('LOG_LEVEL', 'info').toLowerCase();
export const LOG_FILE_MAX_BYTES = envNumber('LOG_FILE_MAX_BYTES', 10 * 1024 * 1024);
export const LOG_FILE_MAX_ROTATIONS = envNumber('LOG_FILE_MAX_ROTATIONS', 3);
export const LOG_FLUSH_INTERVAL_MS = envNumber('LOG_FLUSH_INTERVAL_MS', 100);

export const PAGE_TTL_MS = envNumber('CODEWIKI_PAGE_TTL_MS', 24 * 60 * 60 * 1000);
export const REPO_TTL_MS = envNumber('CODEWIKI_REPO_TTL_MS', 7 * 24 * 60 * 60 * 1000);
export const WIKI_STATUS_TTL_MS = envNumber('CODEWIKI_WIKI_STATUS_TTL_MS', 24 * 60 * 60 * 1000);

export const MAX_CONCURRENT_PAGES = envNumber('CODEWIKI_MAX_CONCURRENT_PAGES', 3);
export const RATE_LIMIT_INTERVAL_MS = envNumber('CODEWIKI_RATE_LIMIT_INTERVAL_MS', 4000);
export const PAGE_LOAD_TIMEOUT_MS = envNumber('CODEWIKI_PAGE_LOAD_TIMEOUT_MS', 30_000);

export const MAX_MANIFEST_BYTES = envNumber('CODEWIKI_MAX_MANIFEST_BYTES', 1024 * 1024);
export const MAX_WALK_DEPTH = envNumber('CODEWIKI_MAX_WALK_DEPTH', 32);

export const FETCH_TIMEOUT_MS = envNumber('CODEWIKI_FETCH_TIMEOUT_MS', 5000);

export const DEFAULT_MAX_TOKENS = envNumber('CODEWIKI_DEFAULT_MAX_TOKENS', 8000);

export const FORCE_INMEMORY_CACHE = envBool('CODEWIKI_FORCE_INMEMORY');

export const CODEWIKI_BASE_URL = 'https://codewiki.google/github.com/';

// v2.2 additions
export const INCLUDE_DEV_DEPS_DEFAULT = envBool('CODEWIKI_INCLUDE_DEV_DEPS');
export const DISABLE_MANIFEST_WATCH = envBool('CODEWIKI_DISABLE_WATCH');
export const MAX_WORKSPACE_MEMBERS = envNumber('CODEWIKI_MAX_WORKSPACE_MEMBERS', 256);

// v2.3 additions — total watcher-handle cap (union across manifestPath +
// derived member manifests + extraManifestFiles). Overflow flips watcher into
// degraded mode (full rescan on every event) instead of throwing.
export const MAX_WATCHED_PATHS = envNumber('CODEWIKI_MAX_WATCHED_PATHS', 512);

// v2.5: bounded depth for the recursive Maven BOM walker. Spring Boots
// canonical pattern is one level (app -> spring-boot-dependencies); chains
// past 5 levels are pathological and indicate either a configuration bug or
// a cycle the visited-Set did not catch (defense-in-depth).
export const MAX_BOM_DEPTH = envNumber('CODEWIKI_MAX_BOM_DEPTH', 5);

// ---------------------------------------------------------------------------
// v2.6 MetricAggregator config
// ---------------------------------------------------------------------------

/** Opt-in: when true, Logger.metric routes to MetricAggregator + periodic flush. */
export const METRIC_AGGREGATE_ENABLED = envBool('CODEWIKI_METRIC_AGGREGATE');

/** Periodic flush interval for the aggregator. Default 30 s. */
export const METRIC_FLUSH_INTERVAL_MS = envNumber('CODEWIKI_METRIC_FLUSH_INTERVAL_MS', 30000);

/**
 * Names suppressed at per-event emission when the aggregator is enabled.
 * High-volume metric names whose debugging value at per-event granularity
 * is bounded; aggregated count/sum/min/max/p50/p95 is sufficient.
 */
export const METRIC_AGGREGATE_HIGH_VOLUME_NAMES = Object.freeze(['cache_hit', 'cache_miss']);

// ---------------------------------------------------------------------------
// v2.8 Startup auto-prewarm config
// ---------------------------------------------------------------------------

/** Opt-out: when true, the prewarmer is not instantiated at startup. */
export const DISABLE_PREWARM = envBool('CODEWIKI_DISABLE_PREWARM');

/**
 * Per-session cap on deps appended to the prewarm queue. 0 = unlimited. When
 * the cap is reached, further inputs are dropped with `prewarm_skipped
 * reason=cap` + a warn-log. Allows 0 as an explicit "unlimited" sentinel —
 * envNumber's `> 0` guard would coerce 0 to the fallback, so we parse inline.
 */
export const PREWARM_MAX_DEPS = (() => {
  const raw = process.env.CODEWIKI_PREWARM_MAX_DEPS;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();

/**
 * Delay (ms) between Prewarmer.start() and the first dequeue. Lets the stdio
 * handshake settle without contending with the bg worker. Default 0 — start
 * draining immediately via setImmediate. Allows 0 explicitly.
 */
export const PREWARM_START_DELAY_MS = (() => {
  const raw = process.env.CODEWIKI_PREWARM_START_DELAY_MS;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
})();
