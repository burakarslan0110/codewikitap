import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGoMod } from '../../../src/adapters/manifests/go_mod.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, '..', '..', 'fixtures', 'manifests', 'go.mod'),
  'utf8',
);

describe('parseGoMod', () => {
  it('parses both block-form and single-line require directives', () => {
    const deps = parseGoMod(FIXTURE);
    const names = deps.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        'github.com/google/uuid',
        'github.com/spf13/cobra',
        'github.com/stretchr/testify',
        'golang.org/x/sync',
      ].sort(),
    );
    deps.forEach((d) => expect(d.ecosystem).toBe('go'));
    expect(deps.find((d) => d.name === 'github.com/spf13/cobra')?.declaredVersion).toBe('v1.9.0');
    expect(deps.find((d) => d.name === 'github.com/google/uuid')?.declaredVersion).toBe('v1.6.0');
  });

  it('excludes deps marked // indirect', () => {
    const deps = parseGoMod(FIXTURE);
    const names = deps.map((d) => d.name);
    expect(names).not.toContain('github.com/davecgh/go-spew');
    expect(names).not.toContain('github.com/pmezard/go-difflib');
  });

  it('ignores retract, replace, module, and go directives', () => {
    const deps = parseGoMod(FIXTURE);
    const names = deps.map((d) => d.name);
    // module path / replace target should never be returned as a dependency.
    expect(names).not.toContain('example.com/fixture-app');
    expect(names).not.toContain('github.com/old/pkg');
    expect(names).not.toContain('github.com/new/pkg');
    // Empty input also returns []
    expect(parseGoMod('')).toEqual([]);
    expect(parseGoMod('module foo\n\ngo 1.22\n')).toEqual([]);
  });

  it('back-compat: one-arg call still works AND every dep has kind=runtime (v2.2 mock-audit sweep)', () => {
    const deps = parseGoMod(FIXTURE);
    expect(deps.length).toBeGreaterThan(0);
    deps.forEach((d) => expect(d.kind).toBe('runtime'));
  });
});
