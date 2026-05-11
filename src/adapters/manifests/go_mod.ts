/**
 * go.mod parser. Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * Recognises both forms:
 *   require <module-path> <version>
 *   require ( <module-path> <version> ... )
 *
 * Skips: lines marked `// indirect`, `module`, `go`, `replace`, `retract`,
 * `exclude`, and any directive that isn't `require`.
 */

import { Dependency } from '../../types.js';

// v2.2: signature widened with opts for symmetry. go.mod has no dev/runtime
// concept; opts.includeDev is accepted but ignored, every dep is kind='runtime'.
export function parseGoMod(
  source: string,
  _opts?: { includeDev?: boolean },
): Dependency[] {
  const out: Dependency[] = [];
  const lines = source.split(/\r?\n/);
  let inRequireBlock = false;

  for (let raw of lines) {
    let line = raw.trim();
    if (line.length === 0) continue;

    // Block-end marker.
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }

    // If inside a block, consume each line as a dep entry.
    if (inRequireBlock) {
      addEntryIfDirect(line, out);
      continue;
    }

    // Block-start: `require (` (possibly with trailing comment).
    if (/^require\s*\(\s*$/.test(line)) {
      inRequireBlock = true;
      continue;
    }

    // Single-line require.
    const single = /^require\s+(.+)$/.exec(line);
    if (single) {
      addEntryIfDirect(single[1], out);
      continue;
    }

    // Anything else (module, go, replace, retract, exclude, comments) — skip.
  }
  return out;
}

function addEntryIfDirect(entry: string, out: Dependency[]): void {
  // Strip line-end comments — `// foo`. If the comment contains `indirect`,
  // skip the entry entirely.
  const commentIdx = entry.indexOf('//');
  let comment = '';
  let body = entry;
  if (commentIdx >= 0) {
    comment = entry.slice(commentIdx + 2).trim();
    body = entry.slice(0, commentIdx).trim();
  } else {
    body = entry.trim();
  }
  if (comment.includes('indirect')) return;
  if (body.length === 0) return;

  // Tokens: <module-path> <version>
  const tokens = body.split(/\s+/);
  if (tokens.length < 2) return;
  const name = tokens[0];
  const declaredVersion = tokens[1];

  // Module paths can contain slashes, dots, hyphens, etc. We do a permissive
  // sanity check: must contain at least one `/` or be a valid hostname-ish path.
  if (!/^[A-Za-z0-9][A-Za-z0-9./_-]*$/.test(name)) return;

  out.push({ name, ecosystem: 'go', declaredVersion, kind: 'runtime' });
}
