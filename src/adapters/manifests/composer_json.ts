/**
 * composer.json (PHP / Composer) parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v2.2 scope:
 *   - require       → kind: 'runtime'
 *   - require-dev   → kind: 'dev' (only when opts.includeDev === true)
 *   - Platform packages (php, hhvm, ext-*, lib-*) are filtered — they're
 *     constraints on the runtime, not real packages.
 *
 * Output is sorted by `name` for determinism.
 */

import { Dependency, ManifestError } from '../../types.js';

// Platform packages: exact "php" / "hhvm" (runtime version constraints), or
// any "ext-..." / "lib-..." prefix (extension/library constraints). Crucially,
// real packages like "phpunit/phpunit" are NOT matched — note the anchored
// alternatives below.
const PLATFORM_PACKAGE_RE = /^(?:php|hhvm)$|^(?:ext|lib)-/;

interface ComposerShape {
  require?: Record<string, unknown>;
  ['require-dev']?: Record<string, unknown>;
}

export function parseComposerJson(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `composer.json is not valid JSON: ${reason}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ManifestError('parse_error', 'composer.json root must be a JSON object');
  }

  const doc = parsed as ComposerShape;
  const out: Dependency[] = [];
  collectGroup(doc.require, 'runtime', out);
  if (opts?.includeDev === true) {
    collectGroup(doc['require-dev'], 'dev', out);
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function collectGroup(
  table: Record<string, unknown> | undefined,
  kind: 'runtime' | 'dev',
  out: Dependency[],
): void {
  if (!table || typeof table !== 'object' || Array.isArray(table)) return;
  for (const [name, version] of Object.entries(table)) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (PLATFORM_PACKAGE_RE.test(name)) continue;

    out.push({
      name,
      ecosystem: 'composer',
      declaredVersion: typeof version === 'string' ? version : undefined,
      kind,
    });
  }
}
