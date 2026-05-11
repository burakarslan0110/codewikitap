/**
 * Visual Studio `*.sln` parser.
 * Pure: takes a string, returns relative csproj paths. No I/O.
 *
 * v2.4 scope:
 *   - Extracts `Project("{<TypeGuid>}") = "<name>", "<relative-path>", "{<ProjectGuid>}"`
 *     lines.
 *   - Filters to `.csproj` only — `.fsproj`, `.vbproj`, `.shproj`, and
 *     solution folders (TypeGuid `2150E333-...`) are skipped. Filtering by
 *     extension on the relative path (NOT by GUID) since SDK-style and
 *     legacy csproj GUIDs differ; the `.csproj` suffix is the stable
 *     contract.
 *   - Path separators normalized: backslashes → forward slashes for
 *     cross-platform consumers.
 *
 * Returns an array of UNIQUE relative csproj paths in declaration order.
 * Returns an empty array on malformed input (sln files NEVER throw — the
 * scanner falls back to dir-only csproj-glob behavior on parse failure).
 */

const PROJECT_LINE_RE =
  /^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"\{[^}]+\}"\s*$/i;

export function parseSln(source: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = PROJECT_LINE_RE.exec(line);
    if (!m) continue;
    const relPath = m[2].replace(/\\/g, '/');
    if (!/\.csproj$/i.test(relPath)) continue;
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    out.push(relPath);
  }
  return out;
}
