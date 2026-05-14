/**
 * Boot-time capability surface.
 *
 * Synchronous one-shot — emits a single `runtime_capabilities` log line
 * after `transport.connect()`. The line tells the user (via stderr) which
 * native deps engaged and whether Playwright is ready, so cross-platform
 * degradations surface BEFORE the first slow tool call.
 *
 * Lives in `src/` (not `src/services/` or `src/adapters/`) because it has
 * no dependencies of its own — it reads already-tracked state from the
 * Cache and PlaywrightDriver and forwards it to the logger.
 */
import type { Logger } from './logging.js';

export type PlaywrightReadyState = 'pending' | 'ready' | 'failed';

/** Narrow read-only view of the Cache surface this helper consumes. */
export interface RuntimeCapabilitiesCacheView {
  readonly isInMemory: boolean;
  readonly vecAvailable: boolean;
}

/** Narrow read-only view of the PlaywrightDriver surface this helper consumes. */
export interface RuntimeCapabilitiesDriverView {
  readonly readyState: PlaywrightReadyState;
}

export interface RuntimeCapabilitiesDeps {
  readonly cache: RuntimeCapabilitiesCacheView;
  readonly driver: RuntimeCapabilitiesDriverView;
  readonly log: Logger;
  /**
   * Test seam — production omits this and the helper reads `process.versions`,
   * `process.platform`, `process.arch` directly.
   */
  readonly processSnapshot?: NodeJS.Process;
}

export function detectRuntimeCapabilities(deps: RuntimeCapabilitiesDeps): void {
  const proc = deps.processSnapshot ?? process;
  deps.log.info('runtime_capabilities', {
    betterSqlite3: !deps.cache.isInMemory,
    sqliteVec: deps.cache.vecAvailable,
    playwright: deps.driver.readyState,
    nodeVersion: proc.versions.node,
    platform: proc.platform,
    arch: proc.arch,
  });
}
