import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseComposerJson } from '../../../src/adapters/manifests/composer_json.js';
import { ManifestError } from '../../../src/types.js';

const FIXTURE = resolve(__dirname, '../../fixtures/manifests/composer.json');

describe('parseComposerJson', () => {
  it('returns runtime-only deps with kind=runtime when called without opts', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseComposerJson(source);

    const names = deps.map((d) => d.name);
    expect(names).toContain('laravel/framework');
    expect(names).toContain('guzzlehttp/guzzle');
    // Platform packages must be filtered.
    expect(names).not.toContain('php');
    expect(names).not.toContain('ext-mbstring');
    expect(names).not.toContain('lib-curl');
    // Dev deps are excluded by default.
    expect(names).not.toContain('phpunit/phpunit');

    for (const d of deps) {
      expect(d.ecosystem).toBe('composer');
      expect(d.kind).toBe('runtime');
    }
  });

  it('preserves vendor/package format and declaredVersion', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseComposerJson(source);
    const laravel = deps.find((d) => d.name === 'laravel/framework');
    expect(laravel?.declaredVersion).toBe('^11.0');
  });

  it('includes require-dev tagged kind=dev when opts.includeDev is true; still drops platform deps', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseComposerJson(source, { includeDev: true });
    const phpunit = deps.find((d) => d.name === 'phpunit/phpunit');
    expect(phpunit?.kind).toBe('dev');

    // ext-xdebug is a platform dep in require-dev — also filtered.
    expect(deps.find((d) => d.name === 'ext-xdebug')).toBeUndefined();
  });

  it('returns deps sorted by name for determinism', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseComposerJson(source, { includeDev: true });
    const names = deps.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });

  it('returns [] when neither require nor require-dev is present', () => {
    expect(parseComposerJson('{}')).toEqual([]);
    expect(parseComposerJson('{}', { includeDev: true })).toEqual([]);
  });

  it('throws ManifestError(parse_error) on malformed JSON', () => {
    expect(() => parseComposerJson('not json {')).toThrow(ManifestError);
    try {
      parseComposerJson('not json {');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).kind).toBe('parse_error');
    }
  });
});
