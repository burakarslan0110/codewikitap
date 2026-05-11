/**
 * pyproject.toml parser.
 *
 * v2.2: migrated from a hand-rolled parser to `@iarna/toml` (added in v2.2's
 * Task 1) so Poetry's nested-table blocks can be read uniformly. The migration
 * is gated by a regression test in `tests/unit/manifests/pyproject_toml.test.ts`
 * that asserts the existing PEP 621 fixture produces the same `Dependency[]`
 * before and after the migration.
 *
 * Priority order:
 *   1. PEP 621 [project.dependencies] — if non-empty, used and Poetry blocks are ignored.
 *   2. [tool.poetry.dependencies]      — falls through when PEP 621 is absent/empty.
 *   3. With opts.includeDev === true:
 *        - [tool.poetry.dev-dependencies] (legacy)
 *        - [tool.poetry.group.<group>.dependencies] (modern; every group treated as 'dev').
 *
 * The synthetic `python` entry in Poetry sections is filtered (it's a
 * Python-version constraint, not a real dep).
 */

import TOML from '@iarna/toml';

import { Dependency, ManifestError } from '../../types.js';

const VERSION_OP_REGEX = /(===|==|!=|<=|>=|~=|<|>)/;

interface PyprojectShape {
  project?: { dependencies?: unknown };
  tool?: {
    poetry?: {
      dependencies?: Record<string, unknown>;
      ['dev-dependencies']?: Record<string, unknown>;
      group?: Record<string, { dependencies?: Record<string, unknown> }>;
    };
  };
}

export function parsePyprojectToml(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  let doc: PyprojectShape;
  try {
    doc = TOML.parse(source) as PyprojectShape;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `pyproject.toml is not valid TOML: ${reason}`);
  }

  // Branch 1: PEP 621 [project.dependencies] (an array of PEP 508 strings).
  const pep621 = parsePep621(doc.project?.dependencies);
  if (pep621.length > 0) return pep621;

  // Branch 2 + 3: Poetry tables.
  const poetry = doc.tool?.poetry;
  const out: Dependency[] = [];
  collectPoetryTable(poetry?.dependencies, 'runtime', out);

  if (opts?.includeDev === true) {
    collectPoetryTable(poetry?.['dev-dependencies'], 'dev', out);
    const groups = poetry?.group;
    if (groups && typeof groups === 'object') {
      for (const groupCfg of Object.values(groups)) {
        collectPoetryTable(groupCfg?.dependencies, 'dev', out);
      }
    }
  }

  return out;
}

function parsePep621(deps: unknown): Dependency[] {
  if (!Array.isArray(deps)) return [];
  const out: Dependency[] = [];
  for (const entry of deps) {
    if (typeof entry !== 'string') continue;
    const dep = parsePep508(entry);
    if (dep) out.push(dep);
  }
  return out;
}

function parsePep508(spec: string): Dependency | null {
  let s = spec;
  const semi = s.indexOf(';');
  if (semi >= 0) s = s.slice(0, semi).trim();
  if (s.length === 0) return null;

  const at = s.indexOf('@');
  if (at >= 0) s = s.slice(0, at).trim();

  const match = VERSION_OP_REGEX.exec(s);
  let nameWithExtras: string;
  let declaredVersion: string | undefined;
  if (match) {
    nameWithExtras = s.slice(0, match.index).trim();
    declaredVersion = s.slice(match.index).trim();
  } else {
    nameWithExtras = s.trim();
  }

  const bracket = nameWithExtras.indexOf('[');
  const name = (bracket >= 0 ? nameWithExtras.slice(0, bracket) : nameWithExtras).trim();

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;

  return { name, ecosystem: 'pypi', declaredVersion, kind: 'runtime' };
}

function collectPoetryTable(
  table: Record<string, unknown> | undefined,
  kind: 'runtime' | 'dev',
  out: Dependency[],
): void {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return;
  for (const [name, raw] of Object.entries(table)) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (name === 'python') continue; // Poetry's Python-version constraint.

    let declaredVersion: string | undefined;
    if (typeof raw === 'string') {
      declaredVersion = raw;
    } else if (raw && typeof raw === 'object') {
      const tableEntry = raw as { version?: unknown };
      if (typeof tableEntry.version === 'string') {
        declaredVersion = tableEntry.version;
      }
    }
    out.push({ name, ecosystem: 'pypi', declaredVersion, kind });
  }
}
