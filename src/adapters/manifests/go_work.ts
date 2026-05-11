/**
 * Go workspace `go.work` parser.
 * Pure: takes a string, returns the relative `use` directory paths. No I/O.
 *
 * v2.4 scope:
 *   - Extracts `use ./moduleA` (single-line) and `use (\n  ./modA\n  ./modB\n)`
 *     (block) directives. Mirrors `parseGoMod`'s require-block parsing shape.
 *   - Comments (`// ...` to EOL) stripped before token matching.
 *   - Other directives — `go`, `toolchain`, `replace`, `exclude` — are
 *     ignored. v2.4 does NOT honor `replace` for local-path resolution.
 *   - Path normalization is left to the caller; we return paths as-written.
 */

export function parseGoWork(source: string): string[] {
  const out: string[] = [];
  const lines = source.split(/\r?\n/);
  let inUseBlock = false;

  for (const raw of lines) {
    let line = raw.trim();
    if (line.length === 0) continue;

    // Strip line-end comments.
    const commentIdx = line.indexOf('//');
    if (commentIdx >= 0) line = line.slice(0, commentIdx).trim();
    if (line.length === 0) continue;

    if (inUseBlock) {
      if (line === ')') {
        inUseBlock = false;
        continue;
      }
      // Each line in a use block is a single relative path.
      if (line.length > 0) out.push(line);
      continue;
    }

    if (/^use\s*\(\s*$/.test(line)) {
      inUseBlock = true;
      continue;
    }

    const single = /^use\s+(.+)$/.exec(line);
    if (single) {
      const p = single[1].trim();
      if (p.length > 0) out.push(p);
      continue;
    }

    // Other directives — ignore.
  }
  return out;
}
