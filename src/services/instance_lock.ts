/**
 * Instance multiplicity detection.
 *
 * The v0.7.0 deployment revealed (via parallel heartbeats in server.log) that
 * Claude Code and other MCP clients can spawn multiple codewikitap children
 * against the same `$XDG_CACHE_HOME/cache.db` — each child loads its own
 * `@xenova/transformers` models (~600–900 MB native RSS), and on a 7.5 GB /
 * 2 GB-swap host three siblings is enough to trigger the OOM-killer despite
 * the V8 heap cap.
 *
 * This module gives operators forensic visibility (not enforcement — multi-
 * instance is legitimate, e.g. one Claude Code session per repo). At boot
 * each instance writes `<cache_dir>/instances/<pid>.json` and emits an
 * `instance.siblings_detected` warn-log when any other recorded PID is still
 * alive. On shutdown the instance removes its own file. Stale entries
 * (process gone) are pruned during the boot scan.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CACHE_DIR } from '../config.js';
import { getLogger } from '../logging.js';

interface InstanceRecord {
  readonly pid: number;
  readonly startedAt: number;
  readonly execPath: string;
  readonly argv: readonly string[];
}

/** Path to the per-PID instance file. Resolved from CACHE_DIR for testability. */
function instanceFile(dir: string, pid: number): string {
  return path.join(dir, 'instances', `${pid}.json`);
}

/** Best-effort liveness probe — signal 0 throws on dead/foreign PIDs. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface InstanceLockHandle {
  /** Sibling PIDs (alive on this host at boot). */
  readonly siblings: readonly number[];
  /** Remove this instance's record. Best-effort; safe to call multiple times. */
  release(): void;
}

export interface RegisterInstanceOptions {
  /** Override the cache directory (test seam). */
  readonly cacheDir?: string;
  /** Override `process.pid` (test seam). */
  readonly pid?: number;
}

/**
 * Register this process as a live codewikitap instance, prune stale records,
 * detect alive siblings, and emit a warn-log when found. Returns a release
 * handle the bin entry's `closer()` calls on shutdown.
 */
export function registerInstance(opts: RegisterInstanceOptions = {}): InstanceLockHandle {
  const log = getLogger();
  const dir = opts.cacheDir ?? CACHE_DIR;
  const pid = opts.pid ?? process.pid;
  const instancesDir = path.join(dir, 'instances');

  try {
    fs.mkdirSync(instancesDir, { recursive: true });
  } catch (err) {
    // Cache dir not writable — degrade gracefully, no detection.
    log.warn('instance_lock.mkdir_failed', { reason: err instanceof Error ? err.message : String(err) });
    return { siblings: [], release: () => {} };
  }

  // 1. Scan existing entries; prune stale; collect live siblings.
  const siblings: number[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(instancesDir);
  } catch {
    /* readdir failed — treat as empty */
  }
  for (const name of files) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const otherPid = Number.parseInt(m[1]!, 10);
    if (otherPid === pid) continue; // own previous run (crashed without release)
    const filePath = path.join(instancesDir, name);
    if (isAlive(otherPid)) {
      siblings.push(otherPid);
    } else {
      try { fs.unlinkSync(filePath); } catch { /* race with another instance; ignore */ }
    }
  }

  // 2. Register self. Single atomic write — collision with another spawn at
  // the same PID is impossible (kernel uniqueness).
  const record: InstanceRecord = {
    pid,
    startedAt: Date.now(),
    execPath: process.execPath,
    argv: process.argv.slice(),
  };
  try {
    fs.writeFileSync(instanceFile(dir, pid), JSON.stringify(record), 'utf-8');
  } catch (err) {
    log.warn('instance_lock.write_failed', { reason: err instanceof Error ? err.message : String(err) });
  }

  // 3. Forensic warn-log when siblings detected.
  if (siblings.length > 0) {
    log.warn('instance.siblings_detected', {
      ownPid: pid,
      siblingPids: siblings,
      siblingCount: siblings.length,
      hint: 'Multiple codewikitap processes share the same cache.db; each loads its own embedder+reranker (~700 MB native RSS). On a low-RAM host this can trigger the OOM-killer despite the V8 heap cap.',
    });
  } else {
    log.info('instance.solo', { ownPid: pid });
  }

  return {
    siblings,
    release: () => {
      try { fs.unlinkSync(instanceFile(dir, pid)); } catch { /* already gone or never written */ }
    },
  };
}
