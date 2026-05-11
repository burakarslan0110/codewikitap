/**
 * package.json (npm/yarn/pnpm/bun) parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v1 scope: only the `dependencies` field. v2.2 adds opt-in `devDependencies`
 * via `opts.includeDev`. v2.8 adds opt-in `optionalDependencies` via
 * `opts.includeOptional` (tool default true); peerDependencies remain out of
 * scope (consumer-facing API surface, not the project's own runtime).
 */

import { Dependency, ManifestError } from '../../types.js';

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export function parsePackageJson(
  source: string,
  opts?: { includeDev?: boolean; includeOptional?: boolean },
): Dependency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `package.json is not valid JSON: ${reason}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManifestError('parse_error', 'package.json root must be a JSON object');
  }

  const shape = parsed as PackageJsonShape;
  const out: Dependency[] = [];
  collectGroup(shape.dependencies, 'runtime', 'dependencies', out);
  if (opts?.includeDev === true) {
    collectGroup(shape.devDependencies, 'dev', 'devDependencies', out);
  }
  if (opts?.includeOptional === true) {
    collectGroup(shape.optionalDependencies, 'optional', 'optionalDependencies', out);
  }
  return out;
}

function collectGroup(
  table: Record<string, string> | undefined,
  kind: 'runtime' | 'dev' | 'optional',
  fieldName: string,
  out: Dependency[],
): void {
  if (!table) return;
  if (typeof table !== 'object' || Array.isArray(table)) {
    throw new ManifestError('parse_error', `package.json \`${fieldName}\` must be an object`);
  }
  for (const [name, version] of Object.entries(table)) {
    if (typeof name !== 'string' || name.length === 0) continue;
    out.push({
      name,
      ecosystem: 'npm',
      declaredVersion: typeof version === 'string' ? version : undefined,
      kind,
    });
  }
}
