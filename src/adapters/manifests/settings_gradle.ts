/**
 * Gradle `settings.gradle` / `settings.gradle.kts` parser.
 * Pure: takes a string, returns subproject directory paths. No I/O.
 *
 * v2.4 scope:
 *   - Discovery only — extracts subproject names from `include(...)` calls.
 *   - Per-subproject `build.gradle(.kts)` is NOT parsed (DSL parsing stays
 *     v2.5-deferred). The dep source for Gradle projects remains
 *     `gradle/libs.versions.toml`.
 *   - Supports Groovy single-quote (`include 'a', ':b'`), Groovy double-quote
 *     (`include "a", ":b"`), and Kotlin DSL (`include("a", ":b")`).
 *   - Multi-line `include(\n  ":a",\n  ":b"\n)` Kotlin DSL form supported.
 *   - Subproject normalization: leading `:` stripped, internal `:` → `/`
 *     (Gradle convention: `:foo:bar` maps to `foo/bar/`).
 *   - Line comments (`// ...`) and block comments stripped BEFORE matching
 *     so commented-out includes don't generate false subprojects.
 *
 * Returns an array of UNIQUE subproject paths in declaration order.
 */

const STRING_LITERAL_RE = /['"]([^'"]+)['"]/g;
const KOTLIN_INCLUDE_RE = /\binclude\s*\(([^)]*)\)/g;
const GROOVY_INCLUDE_RE = /^\s*include\s+(['"][^'"]+['"](?:\s*,\s*['"][^'"]+['"])*)/gm;

function stripComments(source: string): string {
  // Strip block comments first (lazy, multi-line tolerant).
  let out = source.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip line comments — only outside string literals. Naïve approach is
  // adequate here: settings files almost never embed `//` inside literals.
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

function normalizeSubproject(raw: string): string {
  let s = raw.trim();
  if (s.startsWith(':')) s = s.slice(1);
  return s.replace(/:/g, '/');
}

export function parseSettingsGradle(source: string): string[] {
  const cleaned = stripComments(source);
  const seen = new Set<string>();
  const out: string[] = [];

  // Kotlin DSL: include(...).
  for (const match of cleaned.matchAll(KOTLIN_INCLUDE_RE)) {
    const args = match[1] ?? '';
    for (const lit of args.matchAll(STRING_LITERAL_RE)) {
      const norm = normalizeSubproject(lit[1]);
      if (norm.length === 0) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
  }

  // Groovy: bare `include 'a', 'b'` (NOT inside parens — those handled above).
  for (const match of cleaned.matchAll(GROOVY_INCLUDE_RE)) {
    const args = match[1] ?? '';
    for (const lit of args.matchAll(STRING_LITERAL_RE)) {
      const norm = normalizeSubproject(lit[1]);
      if (norm.length === 0) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
  }

  return out;
}
