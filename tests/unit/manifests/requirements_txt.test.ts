import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRequirementsTxt } from '../../../src/adapters/manifests/requirements_txt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, '..', '..', 'fixtures', 'manifests', 'requirements.txt'),
  'utf8',
);

describe('parseRequirementsTxt', () => {
  it('returns an empty list for empty input', () => {
    expect(parseRequirementsTxt('')).toEqual([]);
    expect(parseRequirementsTxt('\n\n   \n')).toEqual([]);
  });

  it('parses a simple requirements list as pypi entries', () => {
    const deps = parseRequirementsTxt('requests\nnumpy\n');
    expect(deps.map((d) => d.name).sort()).toEqual(['numpy', 'requests']);
    deps.forEach((d) => expect(d.ecosystem).toBe('pypi'));
  });

  it('strips full-line and inline comments', () => {
    const deps = parseRequirementsTxt(FIXTURE);
    const names = deps.map((d) => d.name);
    expect(names).not.toContain('Production');
    // Inline comment after `flask~=3.0  # ...` must not bleed into the version.
    const flask = deps.find((d) => d.name === 'flask');
    expect(flask?.declaredVersion).toBe('~=3.0');
  });

  it('captures version pins on the declaredVersion field', () => {
    const deps = parseRequirementsTxt(FIXTURE);
    expect(deps.find((d) => d.name === 'requests')?.declaredVersion).toBe('==2.31.0');
    expect(deps.find((d) => d.name === 'django')?.declaredVersion).toBe('>=4.2,<5.0');
    expect(deps.find((d) => d.name === 'numpy')?.declaredVersion).toBeUndefined();
  });

  it('ignores editable installs, -r references, and strips environment markers', () => {
    const deps = parseRequirementsTxt(FIXTURE);
    const names = deps.map((d) => d.name);
    expect(names).not.toContain('-e');
    expect(names).not.toContain('-r');
    expect(names).not.toContain('./local-pkg');
    // sqlalchemy is kept (only the env marker is stripped).
    const sqlalchemy = deps.find((d) => d.name === 'sqlalchemy');
    expect(sqlalchemy).toBeDefined();
    expect(sqlalchemy?.declaredVersion).toBe('>=2.0');
  });

  it('back-compat: one-arg call still works AND every dep has kind=runtime (v2.2 mock-audit sweep)', () => {
    const deps = parseRequirementsTxt(FIXTURE);
    expect(deps.length).toBeGreaterThan(0);
    deps.forEach((d) => expect(d.kind).toBe('runtime'));
  });

  it('opts.includeDev is accepted but ignored (no native dev split in requirements.txt)', () => {
    const a = parseRequirementsTxt(FIXTURE);
    const b = parseRequirementsTxt(FIXTURE, { includeDev: true });
    expect(a.map((d) => d.name)).toEqual(b.map((d) => d.name));
  });
});
