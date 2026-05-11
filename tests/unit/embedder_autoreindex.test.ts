import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { Cache } from '../../src/services/cache.js';
import { VectorStore } from '../../src/services/vector_store.js';
import { runEmbedderAutoReindex } from '../../src/index.js';
import { EMBED_MODEL, EMBED_MODEL_DIM, LEGACY_EMBED_MODEL_DEFAULT } from '../../src/config_rag.js';

// runEmbedderAutoReindex calls Cache.open() with no args — it uses the
// process-wide CACHE_DB_PATH. We force in-memory via the env override
// (CODEWIKI_FORCE_INMEMORY) and pre-populate via a separate Cache instance.
describe('runEmbedderAutoReindex (v2.5)', () => {
  beforeEach(() => {
    process.env.CODEWIKI_FORCE_INMEMORY = '1';
  });

  it('branch 3: null fingerprint + empty index → no-op (genuine fresh install)', async () => {
    // Pre-state: empty cache, no fingerprint.
    const c0 = await Cache.open({ forceInMemory: true });
    expect(c0.getEmbedderFingerprint()).toBeNull();
    c0.close();

    await runEmbedderAutoReindex();

    // Note: runEmbedderAutoReindex opens its OWN cache instance. With in-memory
    // backend each Cache.open() is independent, so we cannot observe the result
    // across instances. Instead we assert the function completes without throw
    // and that an INSPECTABLE in-memory cache (created BEFORE) reflects no
    // legacy synthesis happened. (Indirect — see also TS-006 for the
    // integration-level observable.)
    const c = await Cache.open({ forceInMemory: true });
    expect(c.getEmbedderFingerprint()).toBeNull();
    c.close();
  });
});

// Cleaner direct tests of the building blocks the hook composes:
describe('Cache.getEmbedderFingerprint + VectorStore.hasAnyIndex (v2.5 building blocks)', () => {
  it('hasAnyIndex returns false on a fresh DB', async () => {
    const c = await Cache.open({ forceInMemory: true });
    const store = new VectorStore(c);
    expect(store.hasAnyIndex()).toBe(false);
    c.close();
  });

  it('hasAnyIndex returns true when wiki_index_status has a row', async () => {
    const c = await Cache.open({ forceInMemory: true });
    const store = new VectorStore(c);
    store.upsertWikiIndexStatus('owner/repo', 'aabb' + 'c'.repeat(36), 5, 0);
    expect(store.hasAnyIndex()).toBe(true);
    c.close();
  });

  it('dropAllChunks empties chunks + wiki_index_status atomically', async () => {
    const c = await Cache.open({ forceInMemory: true });
    const store = new VectorStore(c);
    store.upsertWikiIndexStatus('owner/repo', 'aabb' + 'c'.repeat(36), 5, 0);
    expect(store.hasAnyIndex()).toBe(true);
    store.dropAllChunks();
    expect(store.hasAnyIndex()).toBe(false);
    c.close();
  });

  it('LEGACY_EMBED_MODEL_DEFAULT matches the v2/v2.4 default (sanity guard for the contract)', () => {
    expect(LEGACY_EMBED_MODEL_DEFAULT.model).toBe('Xenova/bge-small-en-v1.5');
    expect(LEGACY_EMBED_MODEL_DEFAULT.dim).toBe(384);
  });

  it('current EMBED_MODEL defaults match LEGACY_EMBED_MODEL_DEFAULT (no env override)', () => {
    // Sanity guard: if a future change shifts the default model, the legacy
    // synthesis would mis-classify and the contract documentation needs an
    // update. This test pins both to the same value.
    expect(EMBED_MODEL).toBe(LEGACY_EMBED_MODEL_DEFAULT.model);
    expect(EMBED_MODEL_DIM).toBe(LEGACY_EMBED_MODEL_DEFAULT.dim);
  });
});

// v2.5 (post-verify Claude should_fix): direct end-to-end coverage of
// applyEmbedderAutoReindex (the pure helper extracted from runEmbedderAutoReindex)
// branches 1 (mismatch + drop) + 2 (legacy synthesis) + 3 (no-op).
import { applyEmbedderAutoReindex } from '../../src/index.js';

describe('applyEmbedderAutoReindex — branch coverage (v2.5 post-verify)', () => {
  let stderrLines: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrLines = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it('branch 1: non-null fingerprint mismatch -> drop + warn + stamp current', async () => {
    const cache = await Cache.open({ forceInMemory: true });
    const store = new VectorStore(cache);
    store.upsertWikiIndexStatus('owner/repo', 'aabb' + 'c'.repeat(36), 5, 0);
    cache.setEmbedderFingerprint('Xenova/bge-base-en-v1.5', 768);
    expect(store.hasAnyIndex()).toBe(true);

    applyEmbedderAutoReindex(cache, { model: 'Xenova/bge-small-en-v1.5', dim: 384 });

    expect(store.hasAnyIndex()).toBe(false); // chunks + wiki_index_status dropped
    expect(cache.getEmbedderFingerprint()).toEqual({
      model: 'Xenova/bge-small-en-v1.5',
      dim: 384,
    });

    const joined = stderrLines.join('');
    expect(joined).toContain('model_swap_drop');
    expect(joined).toContain('Xenova/bge-base-en-v1.5'); // old
    expect(joined).toContain('Xenova/bge-small-en-v1.5'); // new
    cache.close();
  });

  it('branch 2 — match: null fingerprint + populated index, legacy default == current -> stamp, no drop', async () => {
    const cache = await Cache.open({ forceInMemory: true });
    const store = new VectorStore(cache);
    store.upsertWikiIndexStatus('owner/repo', 'aabb' + 'c'.repeat(36), 5, 0);
    expect(cache.getEmbedderFingerprint()).toBeNull();
    expect(store.hasAnyIndex()).toBe(true);

    // Current config equals LEGACY_EMBED_MODEL_DEFAULT — synthesized old
    // matches, so no drop, but fingerprint stamped to skip future checks.
    applyEmbedderAutoReindex(cache, {
      model: LEGACY_EMBED_MODEL_DEFAULT.model,
      dim: LEGACY_EMBED_MODEL_DEFAULT.dim,
    });

    expect(store.hasAnyIndex()).toBe(true); // NOT dropped
    expect(cache.getEmbedderFingerprint()).toEqual({
      model: LEGACY_EMBED_MODEL_DEFAULT.model,
      dim: LEGACY_EMBED_MODEL_DEFAULT.dim,
    });
    expect(stderrLines.join('')).not.toContain('model_swap_drop');
    cache.close();
  });

  it('branch 2 — mismatch: null fingerprint + populated index, legacy default != current -> drop + warn + stamp', async () => {
    const cache = await Cache.open({ forceInMemory: true });
    const store = new VectorStore(cache);
    store.upsertWikiIndexStatus('owner/repo', 'aabb' + 'c'.repeat(36), 5, 0);
    expect(cache.getEmbedderFingerprint()).toBeNull();

    // Current config DIFFERS from LEGACY_EMBED_MODEL_DEFAULT — synthesis
    // produces a mismatch, drop fires.
    applyEmbedderAutoReindex(cache, { model: 'Xenova/bge-base-en-v1.5', dim: 768 });

    expect(store.hasAnyIndex()).toBe(false);
    expect(cache.getEmbedderFingerprint()).toEqual({
      model: 'Xenova/bge-base-en-v1.5',
      dim: 768,
    });
    const joined = stderrLines.join('');
    expect(joined).toContain('model_swap_drop');
    expect(joined).toContain(LEGACY_EMBED_MODEL_DEFAULT.model); // synthesized old
    cache.close();
  });

  it('branch 3: null fingerprint + empty index -> no-op (no drop, no fingerprint write)', async () => {
    const cache = await Cache.open({ forceInMemory: true });
    expect(cache.getEmbedderFingerprint()).toBeNull();
    const store = new VectorStore(cache);
    expect(store.hasAnyIndex()).toBe(false);

    applyEmbedderAutoReindex(cache, { model: 'Xenova/bge-base-en-v1.5', dim: 768 });

    expect(cache.getEmbedderFingerprint()).toBeNull(); // unchanged
    expect(store.hasAnyIndex()).toBe(false);
    expect(stderrLines.join('')).not.toContain('model_swap_drop');
    cache.close();
  });

  it('match (non-null fingerprint == current): no-op, fingerprint untouched', async () => {
    const cache = await Cache.open({ forceInMemory: true });
    const store = new VectorStore(cache);
    store.upsertWikiIndexStatus('owner/repo', 'aabb' + 'c'.repeat(36), 5, 0);
    cache.setEmbedderFingerprint('Xenova/bge-base-en-v1.5', 768);

    applyEmbedderAutoReindex(cache, { model: 'Xenova/bge-base-en-v1.5', dim: 768 });

    expect(store.hasAnyIndex()).toBe(true);
    expect(cache.getEmbedderFingerprint()).toEqual({
      model: 'Xenova/bge-base-en-v1.5',
      dim: 768,
    });
    expect(stderrLines.join('')).not.toContain('model_swap_drop');
    cache.close();
  });
});
