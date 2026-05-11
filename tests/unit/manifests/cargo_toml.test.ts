import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCargoToml } from '../../../src/adapters/manifests/cargo_toml.js';
import { ManifestError } from '../../../src/types.js';

const FIXTURE = resolve(__dirname, '../../fixtures/manifests/Cargo.toml');

describe('parseCargoToml', () => {
  it('returns runtime-only deps with kind=runtime when called without opts (back-compat shape)', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseCargoToml(source);

    const names = deps.map((d) => d.name);
    expect(names).toContain('serde');
    expect(names).toContain('tokio');
    expect(names).toContain('anyhow');
    expect(names).toContain('ws-only-dep');
    expect(names).not.toContain('proptest');
    expect(names).not.toContain('serde_json');

    for (const d of deps) {
      expect(d.ecosystem).toBe('cargo');
      expect(d.kind).toBe('runtime');
    }
  });

  it('parses both bare-string and table-form versions correctly', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseCargoToml(source);

    const serde = deps.find((d) => d.name === 'serde');
    expect(serde?.declaredVersion).toBe('1.0');

    const tokio = deps.find((d) => d.name === 'tokio');
    expect(tokio?.declaredVersion).toBe('1.0');

    // workspace-only entries leave declaredVersion undefined
    const wsOnly = deps.find((d) => d.name === 'ws-only-dep');
    expect(wsOnly?.declaredVersion).toBeUndefined();
  });

  it('includes [dev-dependencies] tagged kind=dev when opts.includeDev is true', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseCargoToml(source, { includeDev: true });

    const proptest = deps.find((d) => d.name === 'proptest');
    expect(proptest).toBeDefined();
    expect(proptest?.kind).toBe('dev');
    expect(proptest?.ecosystem).toBe('cargo');

    const serde = deps.find((d) => d.name === 'serde');
    expect(serde?.kind).toBe('runtime');
  });

  it('returns deps sorted by name for determinism', () => {
    const source = readFileSync(FIXTURE, 'utf8');
    const deps = parseCargoToml(source, { includeDev: true });
    const names = deps.map((d) => d.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it('throws ManifestError(parse_error) on malformed TOML', () => {
    const broken = '[dependencies\nfoo = "1"\n'; // missing closing bracket
    expect(() => parseCargoToml(broken)).toThrow(ManifestError);
    try {
      parseCargoToml(broken);
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).kind).toBe('parse_error');
    }
  });

  it('returns [] when neither [dependencies] nor [dev-dependencies] is present', () => {
    const empty = '[package]\nname = "x"\nversion = "0.1.0"\n';
    expect(parseCargoToml(empty)).toEqual([]);
    expect(parseCargoToml(empty, { includeDev: true })).toEqual([]);
  });
});
