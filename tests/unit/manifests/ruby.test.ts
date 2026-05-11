import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  parseGemfile,
  parseGemfileLock,
} from '../../../src/adapters/manifests/ruby.js';

const FIX = (name: string): string =>
  readFileSync(resolve(__dirname, '../../fixtures/manifests', name), 'utf8');

describe('parseGemfileLock', () => {
  it('extracts only the DEPENDENCIES section, ignoring GEM specs and lock metadata', () => {
    const deps = parseGemfileLock(FIX('Gemfile.lock'));
    const names = deps.map((d) => d.name);
    // Direct deps from DEPENDENCIES block:
    expect(names).toContain('pg');
    expect(names).toContain('puma');
    expect(names).toContain('rails');
    expect(names).toContain('tzinfo-data');
    expect(names).toContain('webpacker');
    // Transitives from GEM specs: section MUST be excluded:
    expect(names).not.toContain('actionpack');
    expect(names).not.toContain('activerecord');
    expect(names).not.toContain('actionview');
    expect(names).not.toContain('activemodel');
  });

  it('captures version constraints when present', () => {
    const deps = parseGemfileLock(FIX('Gemfile.lock'));
    expect(deps.find((d) => d.name === 'rails')?.declaredVersion).toBe('~> 7.1.0');
    expect(deps.find((d) => d.name === 'puma')?.declaredVersion).toBe('>= 5.0');
    expect(deps.find((d) => d.name === 'pg')?.declaredVersion).toBeUndefined();
    // The trailing `!` flag on `webpacker (~> 5.0)!` is metadata; the dep is still emitted.
    expect(deps.find((d) => d.name === 'webpacker')?.declaredVersion).toBe('~> 5.0');
  });

  it('tags every lockfile entry as kind=runtime and ecosystem=gem', () => {
    const deps = parseGemfileLock(FIX('Gemfile.lock'));
    for (const d of deps) {
      expect(d.kind).toBe('runtime');
      expect(d.ecosystem).toBe('gem');
    }
  });

  it('returns sorted output for determinism', () => {
    const deps = parseGemfileLock(FIX('Gemfile.lock'));
    const names = deps.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });

  it('returns [] when DEPENDENCIES section is absent', () => {
    expect(parseGemfileLock('GEM\n  remote: x\nPLATFORMS\n  ruby\n')).toEqual([]);
  });
});

describe('parseGemfile', () => {
  it('captures top-level gems as runtime, filters out group :development/:test by default', () => {
    const deps = parseGemfile(FIX('Gemfile'));
    const names = deps.map((d) => d.name);
    expect(names).toContain('rails');
    expect(names).toContain('puma');
    expect(names).toContain('pg');
    expect(names).toContain('tzinfo-data');
    // dev/test gems excluded by default
    expect(names).not.toContain('web-console');
    expect(names).not.toContain('listen');
    expect(names).not.toContain('rspec-rails');
    expect(names).not.toContain('pry');

    expect(deps.find((d) => d.name === 'rails')?.kind).toBe('runtime');
    expect(deps.find((d) => d.name === 'rails')?.declaredVersion).toBe('~> 7.1.0');
  });

  it('emits dev-tagged gems when opts.includeDev is true', () => {
    const deps = parseGemfile(FIX('Gemfile'), { includeDev: true });
    const webConsole = deps.find((d) => d.name === 'web-console');
    expect(webConsole?.kind).toBe('dev');

    const rspec = deps.find((d) => d.name === 'rspec-rails');
    expect(rspec?.kind).toBe('dev');

    // Multi-symbol form `group :development, :test do`
    const pry = deps.find((d) => d.name === 'pry');
    expect(pry?.kind).toBe('dev');
  });

  it('handles inline conditionals (`gem ... if ENV[...]`) — treated as surrounding scope', () => {
    const deps = parseGemfile(FIX('Gemfile'), { includeDev: true });
    // `gem 'pry-byebug' if ENV['DEBUG']` is at top level → runtime
    const pryByebug = deps.find((d) => d.name === 'pry-byebug');
    expect(pryByebug).toBeDefined();
    expect(pryByebug?.kind).toBe('runtime');
  });

  it('handles unbalanced `end` lines without throwing', () => {
    expect(() => parseGemfile("gem 'foo'\nend\nend\n")).not.toThrow();
  });

  it('returns sorted output', () => {
    const deps = parseGemfile(FIX('Gemfile'), { includeDev: true });
    const names = deps.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });
});
