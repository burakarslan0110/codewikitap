import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePyprojectToml } from '../../../src/adapters/manifests/pyproject_toml.js';
import { ManifestError } from '../../../src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, '..', '..', 'fixtures', 'manifests', 'pyproject.toml'),
  'utf8',
);
const POETRY_FIXTURE = fs.readFileSync(
  path.resolve(here, '..', '..', 'fixtures', 'manifests', 'pyproject-poetry.toml'),
  'utf8',
);

describe('parsePyprojectToml', () => {
  it('parses PEP 621 [project.dependencies] into pypi entries (regression gate against v1)', () => {
    const deps = parsePyprojectToml(FIXTURE);
    const names = deps.map((d) => d.name).sort();
    expect(names).toEqual(['fastapi', 'httpx', 'pydantic', 'uvicorn']);
    deps.forEach((d) => expect(d.ecosystem).toBe('pypi'));
    expect(deps.find((d) => d.name === 'fastapi')?.declaredVersion).toBe('>=0.110.0');
    expect(deps.find((d) => d.name === 'pydantic')?.declaredVersion).toBe('~=2.5');
    expect(deps.find((d) => d.name === 'httpx')?.declaredVersion).toBeUndefined();
    // extras like [standard] are stripped from the name
    expect(deps.find((d) => d.name === 'uvicorn')?.declaredVersion).toBe('>=0.27,<0.30');
  });

  it('back-compat: every dep from PEP 621 has kind=runtime when called with no opts', () => {
    const deps = parsePyprojectToml(FIXTURE);
    deps.forEach((d) => expect(d.kind).toBe('runtime'));
  });

  it('parses [tool.poetry.dependencies] when PEP 621 is absent (Poetry-only project)', () => {
    const deps = parsePyprojectToml(POETRY_FIXTURE);
    const names = deps.map((d) => d.name).sort();
    // python is filtered (Python-version constraint, not a real dep).
    expect(names).toEqual(['fastapi', 'httpx', 'pydantic']);
    deps.forEach((d) => expect(d.ecosystem).toBe('pypi'));
    deps.forEach((d) => expect(d.kind).toBe('runtime'));
    expect(deps.find((d) => d.name === 'httpx')?.declaredVersion).toBe('^0.27');
  });

  it('includes legacy [tool.poetry.dev-dependencies] AND modern [tool.poetry.group.<g>.dependencies] when opts.includeDev=true', () => {
    const deps = parsePyprojectToml(POETRY_FIXTURE, { includeDev: true });
    const dev = deps.filter((d) => d.kind === 'dev').map((d) => d.name).sort();
    // legacy: pytest; modern dev group: ruff; modern docs group: mkdocs
    expect(dev).toEqual(['mkdocs', 'pytest', 'ruff']);
    expect(deps.find((d) => d.name === 'fastapi')?.kind).toBe('runtime');
  });

  it('PEP 621 takes priority when both sections exist (mixed file emits PEP 621 only by default)', () => {
    const mixed = `[project]
name = "mixed"
dependencies = [
  "rich>=13.0",
]

[tool.poetry.dependencies]
python = "^3.11"
should-not-appear = "^1.0"
`;
    const deps = parsePyprojectToml(mixed);
    const names = deps.map((d) => d.name);
    expect(names).toEqual(['rich']);
    expect(names).not.toContain('should-not-appear');
  });

  it('Poetry-only file no longer throws (v2.2 supports it; v1 unsupported_format throw is removed)', () => {
    const poetryOnly = `[tool.poetry.dependencies]
python = "^3.10"
fastapi = "^0.110"
`;
    expect(() => parsePyprojectToml(poetryOnly)).not.toThrow();
    const deps = parsePyprojectToml(poetryOnly);
    expect(deps.map((d) => d.name)).toEqual(['fastapi']);
  });

  it('throws ManifestError(parse_error) when TOML is malformed', () => {
    const malformed = `[project]
name = "x"
dependencies = [
  "fastapi"
  "httpx"
`; // unterminated array
    expect(() => parsePyprojectToml(malformed)).toThrow(ManifestError);
    try {
      parsePyprojectToml(malformed);
    } catch (e) {
      expect((e as ManifestError).kind).toBe('parse_error');
    }
  });

  it('returns empty list when pyproject.toml has no [project] AND no [tool.poetry] table', () => {
    const buildOnly = `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
`;
    expect(parsePyprojectToml(buildOnly)).toEqual([]);
  });
});
