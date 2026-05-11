/**
 * pip requirements.txt parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * Handles: # comments (full-line and inline), version specifiers (==, >=, <,
 * ~=, !=, ===, etc.), environment markers (`; python_version >= "3.10"` is
 * stripped). Ignores: -e (editable installs), -r (recursive includes),
 * --hash, blank lines.
 */

import { Dependency } from '../../types.js';

const VERSION_OP_REGEX = /(===|==|!=|<=|>=|~=|<|>)/;

// v2.2: signature widened with opts for symmetry with the other parsers.
// requirements.txt has no native dev/runtime split, so opts.includeDev is
// accepted but ignored — every emitted dep gets kind='runtime'.
export function parseRequirementsTxt(
  source: string,
  _opts?: { includeDev?: boolean },
): Dependency[] {
  const out: Dependency[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine;

    // Strip inline comments (pip allows them after whitespace + #).
    const hashIdx = line.indexOf('#');
    if (hashIdx >= 0) {
      // Inline comments must be preceded by whitespace per PEP 508-ish convention;
      // but pip's own behaviour is more lenient. We strip everything from the
      // first `#` since name/version characters never include `#`.
      line = line.slice(0, hashIdx);
    }
    line = line.trim();
    if (line.length === 0) continue;

    // Skip directive lines and editable installs.
    if (line.startsWith('-e') || line.startsWith('-r') || line.startsWith('--')) continue;

    // Strip environment markers — everything after the first `;`.
    const semiIdx = line.indexOf(';');
    if (semiIdx >= 0) line = line.slice(0, semiIdx).trim();
    if (line.length === 0) continue;

    // Find the first version operator; everything before is the name.
    const match = VERSION_OP_REGEX.exec(line);
    let name: string;
    let declaredVersion: string | undefined;
    if (match) {
      name = line.slice(0, match.index).trim();
      declaredVersion = line.slice(match.index).trim();
    } else {
      name = line.trim();
    }

    // Skip if name doesn't look like a valid PEP 503 distribution name.
    // Allowed: letters, digits, ., -, _ ; must start with a letter or digit.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;

    out.push({ name, ecosystem: 'pypi', declaredVersion, kind: 'runtime' });
  }
  return out;
}
