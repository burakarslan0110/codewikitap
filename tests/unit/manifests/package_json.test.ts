import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePackageJson } from '../../../src/adapters/manifests/package_json.js';
import { ManifestError } from '../../../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, '..', '..', 'fixtures', 'manifests', 'package.json'),
  'utf8',
);

describe('parsePackageJson', () => {
  it('returns an empty list when there are no dependencies', () => {
    const result = parsePackageJson('{"name":"empty","version":"0.0.1"}');
    expect(result).toEqual([]);
  });

  it('parses direct dependencies as npm ecosystem entries with version', () => {
    const deps = parsePackageJson(FIXTURE);
    const names = deps.map((d) => d.name).sort();
    expect(names).toEqual(['next', 'react', 'zod']);
    deps.forEach((d) => expect(d.ecosystem).toBe('npm'));
    expect(deps.find((d) => d.name === 'react')!.declaredVersion).toBe('^19.0.0');
    expect(deps.find((d) => d.name === 'next')!.declaredVersion).toBe('15.1.0');
  });

  it('excludes devDependencies and peerDependencies by default (v2.2 default still off)', () => {
    const deps = parsePackageJson(FIXTURE);
    const names = deps.map((d) => d.name);
    expect(names).not.toContain('vitest');
    expect(names).not.toContain('typescript');
    expect(names).not.toContain('react-dom');
  });

  it('excludes optionalDependencies by default (parser-level opt-in, symmetric with includeDev)', () => {
    const deps = parsePackageJson(FIXTURE);
    const names = deps.map((d) => d.name);
    expect(names).not.toContain('fsevents');
    expect(names).not.toContain('better-sqlite3');
  });

  it('opts.includeOptional=true surfaces optionalDependencies tagged kind=optional', () => {
    const deps = parsePackageJson(FIXTURE, { includeOptional: true });
    const optionals = deps.filter((d) => d.kind === 'optional').map((d) => d.name).sort();
    expect(optionals).toEqual(['better-sqlite3', 'fsevents']);
    const bs3 = deps.find((d) => d.name === 'better-sqlite3')!;
    expect(bs3.ecosystem).toBe('npm');
    expect(bs3.declaredVersion).toBe('^11.5.0');
    // Runtime deps still present with kind=runtime — kinds are disjoint.
    const runtime = deps.filter((d) => d.kind === 'runtime').map((d) => d.name);
    expect(runtime).toContain('react');
  });

  it('back-compat: one-arg call still works AND every dep has kind=runtime set (v2.2 mock-audit sweep)', () => {
    const deps = parsePackageJson(FIXTURE);
    expect(deps.length).toBeGreaterThan(0);
    deps.forEach((d) => expect(d.kind).toBe('runtime'));
  });

  it('opts.includeDev=true surfaces devDependencies tagged kind=dev', () => {
    const deps = parsePackageJson(FIXTURE, { includeDev: true });
    const dev = deps.filter((d) => d.kind === 'dev').map((d) => d.name);
    // The fixture's devDependencies includes vitest and typescript per the v1 test above.
    expect(dev).toContain('vitest');
    expect(dev).toContain('typescript');
    // Runtime deps still present and tagged kind=runtime.
    const runtime = deps.filter((d) => d.kind === 'runtime').map((d) => d.name);
    expect(runtime).toContain('react');
  });

  it('throws ManifestError on malformed JSON', () => {
    expect(() => parsePackageJson('{"deps": ')).toThrow(ManifestError);
    try {
      parsePackageJson('not-json-at-all');
    } catch (e) {
      expect(e).toBeInstanceOf(ManifestError);
      expect((e as ManifestError).kind).toBe('parse_error');
    }
  });
});
