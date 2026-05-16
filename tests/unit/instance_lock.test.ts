/**
 * Unit tests for the multi-instance detection helper.
 *
 * Tests use an isolated `cacheDir` per case so concurrent vitest runs and
 * real codewikitap processes on the host machine don't interfere.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { registerInstance } from '../../src/services/instance_lock.js';

let tmpCacheDir: string;

beforeEach(() => {
  tmpCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-instlock-'));
});
afterEach(() => {
  fs.rmSync(tmpCacheDir, { recursive: true, force: true });
});

describe('registerInstance', () => {
  it('creates instances/<pid>.json on registration', () => {
    const pid = 99999;
    const handle = registerInstance({ cacheDir: tmpCacheDir, pid });
    const file = path.join(tmpCacheDir, 'instances', `${pid}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const record = JSON.parse(fs.readFileSync(file, 'utf-8')) as { pid: number; startedAt: number };
    expect(record.pid).toBe(pid);
    expect(typeof record.startedAt).toBe('number');
    expect(handle.siblings).toEqual([]);
    handle.release();
  });

  it('release() removes the instance file', () => {
    const pid = 99998;
    const handle = registerInstance({ cacheDir: tmpCacheDir, pid });
    const file = path.join(tmpCacheDir, 'instances', `${pid}.json`);
    expect(fs.existsSync(file)).toBe(true);
    handle.release();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('release() is idempotent (safe to call multiple times)', () => {
    const handle = registerInstance({ cacheDir: tmpCacheDir, pid: 99997 });
    handle.release();
    // Second release must not throw — file already gone.
    expect(() => handle.release()).not.toThrow();
  });

  it('prunes stale entries (PID no longer alive)', () => {
    // Write a stale record manually — PID 1 unlikely to be a real codewikitap,
    // BUT process.kill(1, 0) returns "alive" because init always exists. Use
    // a PID we KNOW is dead: a very high PID unlikely to be assigned.
    fs.mkdirSync(path.join(tmpCacheDir, 'instances'), { recursive: true });
    const stalePid = 4194300; // near kernel.pid_max ceiling — almost certainly free
    const staleFile = path.join(tmpCacheDir, 'instances', `${stalePid}.json`);
    fs.writeFileSync(staleFile, JSON.stringify({ pid: stalePid, startedAt: 0, execPath: '', argv: [] }), 'utf-8');

    const handle = registerInstance({ cacheDir: tmpCacheDir, pid: 99996 });
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(handle.siblings).not.toContain(stalePid);
    handle.release();
  });

  it('reports the current PID as a sibling when registered twice (own previous crash)', () => {
    const pid = 99995;
    // Write a "previous run that crashed without release" record — same PID.
    fs.mkdirSync(path.join(tmpCacheDir, 'instances'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpCacheDir, 'instances', `${pid}.json`),
      JSON.stringify({ pid, startedAt: 0, execPath: '', argv: [] }),
      'utf-8',
    );
    // Re-register with the same PID — should NOT report self as sibling.
    const handle = registerInstance({ cacheDir: tmpCacheDir, pid });
    expect(handle.siblings).toEqual([]); // own-PID entry is skipped, not counted as sibling
    handle.release();
  });

  it('detects an alive sibling (current process PID counts as alive)', () => {
    // Plant a record at the current process.pid — it's definitely alive.
    fs.mkdirSync(path.join(tmpCacheDir, 'instances'), { recursive: true });
    const livePid = process.pid;
    fs.writeFileSync(
      path.join(tmpCacheDir, 'instances', `${livePid}.json`),
      JSON.stringify({ pid: livePid, startedAt: 0, execPath: '', argv: [] }),
      'utf-8',
    );
    // Register under a different PID; the planted live entry shows up as sibling.
    const handle = registerInstance({ cacheDir: tmpCacheDir, pid: 99994 });
    expect(handle.siblings).toContain(livePid);
    handle.release();
    // Cleanup planted entry.
    fs.unlinkSync(path.join(tmpCacheDir, 'instances', `${livePid}.json`));
  });

  it('gracefully degrades when cache dir is not writable', () => {
    const handle = registerInstance({ cacheDir: '/nonexistent/path/should/not/exist', pid: 99993 });
    // No throw; sibling list empty; release is a no-op.
    expect(handle.siblings).toEqual([]);
    expect(() => handle.release()).not.toThrow();
  });
});
