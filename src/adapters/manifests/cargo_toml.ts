/**
 * Cargo.toml (Rust) parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v2.2 scope:
 *   - [dependencies]      → kind: 'runtime'
 *   - [dev-dependencies]  → kind: 'dev' (only when opts.includeDev === true)
 *   - [build-dependencies] and [target.*] are NOT parsed in v2.2.
 *   - Workspace-only entries (`{ workspace = true }`) emit declaredVersion=undefined
 *     so the entry still appears for downstream resolution attempts.
 *
 * Output is sorted by `name` because @iarna/toml's table iteration is
 * non-deterministic; sorting makes test snapshots stable.
 */

import TOML from '@iarna/toml';

import { Dependency, ManifestError } from '../../types.js';

interface CargoTable {
  dependencies?: Record<string, unknown>;
  ['dev-dependencies']?: Record<string, unknown>;
}

export function parseCargoToml(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  let doc: CargoTable;
  try {
    doc = TOML.parse(source) as CargoTable;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestError('parse_error', `Cargo.toml is not valid TOML: ${reason}`);
  }

  const out: Dependency[] = [];
  collectGroup(doc.dependencies, 'runtime', out);
  if (opts?.includeDev === true) {
    collectGroup(doc['dev-dependencies'], 'dev', out);
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function collectGroup(
  table: Record<string, unknown> | undefined,
  kind: 'runtime' | 'dev',
  out: Dependency[],
): void {
  if (!table || typeof table !== 'object') return;
  for (const [name, raw] of Object.entries(table)) {
    if (typeof name !== 'string' || name.length === 0) continue;

    let declaredVersion: string | undefined;
    if (typeof raw === 'string') {
      declaredVersion = raw;
    } else if (raw && typeof raw === 'object') {
      const tableEntry = raw as { version?: unknown; workspace?: unknown };
      if (typeof tableEntry.version === 'string') {
        declaredVersion = tableEntry.version;
      }
      // workspace-only entries leave declaredVersion undefined.
    }

    out.push({ name, ecosystem: 'cargo', declaredVersion, kind });
  }
}
