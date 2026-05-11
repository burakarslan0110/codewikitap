import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-mcp-cache-'));
  dbPath = path.join(tmpDir, 'cache.db');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Cache (sqlite-backed)', () => {
  it('round-trips a page entry', async () => {
    const c = await Cache.open({ dbPath });
    const body = { sections: [{ slug: 'a', text: 'hello' }] };
    c.setPage('foo/bar', 'a', body, 'aabbccddeeff00112233445566778899aabbccdd');
    const got = c.getPage('foo/bar', 'a');
    expect(got).not.toBeNull();
    expect(got!.body).toEqual(body);
    expect(got!.commitSha).toBe('aabbccddeeff00112233445566778899aabbccdd');
    expect(typeof got!.fetchedAt).toBe('number');
    c.close();
  });

  it('round-trips a repo resolution', async () => {
    const c = await Cache.open({ dbPath });
    c.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    const got = c.getRepo('react', 'npm');
    expect(got).toEqual(expect.objectContaining({
      owner: 'facebook', repo: 'react', source: 'npm-registry', confidence: 'high',
    }));
    expect(typeof got!.resolvedAt).toBe('number');
    c.close();
  });

  it('round-trips a wiki status entry', async () => {
    const c = await Cache.open({ dbPath });
    const idx = [{ slug: 'overview', title: 'Overview', level: 1, parentSlug: null, hasDiagrams: true }];
    c.setWikiStatus('foo/bar', true, 1, idx);
    const got = c.getWikiStatus('foo/bar');
    expect(got!.hasWiki).toBe(true);
    expect(got!.pageCount).toBe(1);
    expect(got!.pageIndex).toEqual(idx);
    c.close();
  });

  it('returns null on missing keys (does NOT throw)', async () => {
    const c = await Cache.open({ dbPath });
    expect(c.getPage('x', 'y')).toBeNull();
    expect(c.getRepo('zzz', 'npm')).toBeNull();
    expect(c.getWikiStatus('zzz')).toBeNull();
    c.close();
  });

  it('invalidatePage removes the entry', async () => {
    const c = await Cache.open({ dbPath });
    c.setPage('foo/bar', 's', { x: 1 }, 'a'.repeat(40));
    expect(c.getPage('foo/bar', 's')).not.toBeNull();
    c.invalidatePage('foo/bar', 's');
    expect(c.getPage('foo/bar', 's')).toBeNull();
    c.close();
  });

  it('refreshPageTimestamp updates fetchedAt without changing body or sha', async () => {
    const c = await Cache.open({ dbPath });
    c.setPage('foo/bar', 's', { x: 1 }, 'a'.repeat(40));
    const before = c.getPage('foo/bar', 's')!.fetchedAt;
    // Wait a tick to ensure clock moves.
    await new Promise((r) => setTimeout(r, 5));
    c.refreshPageTimestamp('foo/bar', 's');
    const after = c.getPage('foo/bar', 's')!;
    expect(after.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(after.body).toEqual({ x: 1 });
    expect(after.commitSha).toBe('a'.repeat(40));
    c.close();
  });

  it('schema is created idempotently (open + close + reopen does not throw)', async () => {
    const c1 = await Cache.open({ dbPath });
    c1.setRepo('q', 'npm', 'o', 'r', 'fuzzy', 'low');
    c1.close();
    const c2 = await Cache.open({ dbPath });
    expect(c2.getRepo('q', 'npm')?.repo).toBe('r');
    c2.close();
  });

  it('falls back to in-memory mode when forced via env (CODEWIKI_FORCE_INMEMORY)', async () => {
    const c = await Cache.open({ dbPath, forceInMemory: true });
    c.setPage('foo/bar', 's', { x: 1 }, 'a'.repeat(40));
    expect(c.getPage('foo/bar', 's')!.body).toEqual({ x: 1 });
    // No db file should be created when in-memory.
    expect(fs.existsSync(dbPath)).toBe(false);
    c.close();
  });
});

// v2.2: Truth #11 — invalidateRepo / invalidateWikiStatus must produce identical
// observable behaviour on both backends.
describe.each([
  { name: 'sqlite', forceInMemory: false },
  { name: 'in-memory', forceInMemory: true },
])('Cache.invalidateRepo / invalidateWikiStatus — $name backend (v2.2 Truth #11)', ({ forceInMemory }) => {
  it('invalidateRepo removes the (query, ecosystem) row', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    c.setRepo('react', 'npm', 'facebook', 'react', 'npm-registry', 'high');
    expect(c.getRepo('react', 'npm')).not.toBeNull();
    c.invalidateRepo('react', 'npm');
    expect(c.getRepo('react', 'npm')).toBeNull();
    c.close();
  });

  it('invalidateRepo for a non-existent (query, ecosystem) is a no-op (does not throw)', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    expect(() => c.invalidateRepo('does-not-exist', 'npm')).not.toThrow();
    c.close();
  });

  it('invalidateWikiStatus removes the wiki_status row', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    c.setWikiStatus('facebook/react', true, 5, []);
    expect(c.getWikiStatus('facebook/react')).not.toBeNull();
    c.invalidateWikiStatus('facebook/react');
    expect(c.getWikiStatus('facebook/react')).toBeNull();
    c.close();
  });

  it('invalidateWikiStatus for a non-existent repo is a no-op', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    expect(() => c.invalidateWikiStatus('foo/bar')).not.toThrow();
    c.close();
  });
});

// v2.4: maven_bom_versions round-trip on both backends.
describe.each([
  { name: 'sqlite', forceInMemory: false },
  { name: 'in-memory', forceInMemory: true },
])('Cache.maven_bom_versions — $name backend (v2.4)', ({ forceInMemory }) => {
  it('round-trips a BOM version map', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    const map = {
      'org.springframework:spring-core': '6.1.1',
      'org.springframework.boot:spring-boot-starter-web': '3.2.0',
    };
    c.setMavenBomVersions('org.springframework.boot', 'spring-boot-dependencies', '3.2.0', map);
    const got = c.getMavenBomVersions('org.springframework.boot', 'spring-boot-dependencies', '3.2.0');
    expect(got?.versionMap).toEqual(map);
    expect(typeof got?.fetchedAt).toBe('number');
    c.close();
  });

  it('returns null on miss', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    expect(c.getMavenBomVersions('no.such', 'bom', '1.0.0')).toBeNull();
    c.close();
  });
});

// v2.5: embedder fingerprint round-trip + null-on-fresh.
describe.each([
  { name: 'sqlite', forceInMemory: false },
  { name: 'in-memory', forceInMemory: true },
])('Cache.embedderFingerprint — $name backend (v2.5)', ({ forceInMemory }) => {
  it('returns null on a fresh DB (no fingerprint persisted yet)', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    expect(c.getEmbedderFingerprint()).toBeNull();
    c.close();
  });

  it('round-trips (model, dim) via meta rows', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    c.setEmbedderFingerprint('Xenova/bge-base-en-v1.5', 768);
    const got = c.getEmbedderFingerprint();
    expect(got).toEqual({ model: 'Xenova/bge-base-en-v1.5', dim: 768 });
    c.close();
  });

  it('overwrites prior fingerprint on second set (mismatch detection target)', async () => {
    const c = await Cache.open({ dbPath, forceInMemory });
    c.setEmbedderFingerprint('Xenova/bge-small-en-v1.5', 384);
    c.setEmbedderFingerprint('Xenova/bge-base-en-v1.5', 768);
    expect(c.getEmbedderFingerprint()).toEqual({ model: 'Xenova/bge-base-en-v1.5', dim: 768 });
    c.close();
  });
});
