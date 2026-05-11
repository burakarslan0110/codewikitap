/**
 * Gradle `build.gradle` / `build.gradle.kts` parser.
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v2.5 scope:
 *   - **Conservative regex extraction.** NEVER evaluates Groovy/Kotlin (both
 *     are Turing-complete; eval is the deferred-since-v2.2 trap that
 *     `settings_gradle.ts` also avoided).
 *   - **Recognized configurations:**
 *     - runtime: implementation, api, compileOnly, runtimeOnly,
 *       compileClasspath, runtimeClasspath
 *     - dev (only when opts.includeDev): testImplementation, testCompileOnly,
 *       testRuntimeOnly, androidTestImplementation
 *   - **Recognized literal forms (six):**
 *     1. `implementation 'g:a:v'` (Groovy single-quote)
 *     2. `implementation "g:a:v"` (Groovy double-quote)
 *     3. `implementation("g:a:v")` (Kotlin DSL function-call)
 *     4. `implementation group: 'g', name: 'a', version: 'v'` (Groovy named-arg)
 *     5. `implementation(group = "g", name = "a", version = "v")` (Kotlin DSL named-arg)
 *     6. `implementation 'g:a'` and `implementation("g:a")` (no version)
 *   - **NOT recognized (intentional v2.5 gap; documented in plan §Out of Scope):**
 *     variable interpolation (`"$springVersion"`, `${libs.versions.spring}`),
 *     ext-block / variable refs (`implementation deps.spring`),
 *     platform/enforcedPlatform wrappers, conditional blocks,
 *     kapt / annotationProcessor configurations.
 *   - Comments (line `//` + block `/* * /`) stripped BEFORE matching.
 *
 * Sibling export `extractPluginIds(source)` extracts plugin ids from
 * `plugins { ... }` blocks (Groovy + Kotlin DSL) — consumed by the scanner
 * which maps each id through the hardcoded plugin coords table.
 */

import { Dependency } from '../../types.js';

const RUNTIME_CONFIGS = [
  'implementation',
  'api',
  'compileOnly',
  'runtimeOnly',
  'compileClasspath',
  'runtimeClasspath',
];

const DEV_CONFIGS = [
  'testImplementation',
  'testCompileOnly',
  'testRuntimeOnly',
  'androidTestImplementation',
];

function stripComments(source: string): string {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

function configsAlternation(configs: readonly string[]): string {
  return configs.join('|');
}

/**
 * Match `<config> '<g>:<a>[:<v>]'` (single-quote OR double-quote, with or
 * without parens). Captures: config, g, a, v (optional).
 */
function buildShorthandRegex(configs: readonly string[]): RegExp {
  const cfg = configsAlternation(configs);
  // `\(?` and `\)?` allow Kotlin DSL parens around a single string-literal arg.
  // Group 1: config; group 2: open quote; group 3: g:a or g:a:v body.
  return new RegExp(
    `\\b(${cfg})\\s*\\(?\\s*(['"])([^'"]+?)\\2\\s*\\)?`,
    'g',
  );
}

/**
 * Match the Groovy named-arg map form:
 *   <config> group: 'g', name: 'a'[, version: 'v']
 * Order is fixed (group, name, version) to keep the regex tractable. Most
 * real-world build files use this exact order.
 */
function buildGroovyNamedArgRegex(configs: readonly string[]): RegExp {
  const cfg = configsAlternation(configs);
  return new RegExp(
    `\\b(${cfg})\\s+group:\\s*(['"])([^'"]+?)\\2\\s*,\\s*name:\\s*(['"])([^'"]+?)\\4(?:\\s*,\\s*version:\\s*(['"])([^'"]+?)\\6)?`,
    'g',
  );
}

/**
 * Match the Kotlin DSL named-arg form:
 *   <config>(group = "g", name = "a"[, version = "v"])
 */
function buildKotlinNamedArgRegex(configs: readonly string[]): RegExp {
  const cfg = configsAlternation(configs);
  return new RegExp(
    `\\b(${cfg})\\s*\\(\\s*group\\s*=\\s*(['"])([^'"]+?)\\2\\s*,\\s*name\\s*=\\s*(['"])([^'"]+?)\\4(?:\\s*,\\s*version\\s*=\\s*(['"])([^'"]+?)\\6)?\\s*\\)`,
    'g',
  );
}

function isVersionInterpolated(version: string | undefined): boolean {
  if (version === undefined) return false;
  return version.includes('$');
}

function makeDep(
  group: string,
  artifact: string,
  version: string | undefined,
  kind: 'runtime' | 'dev',
): Dependency | null {
  if (!group || !artifact) return null;
  if (isVersionInterpolated(version)) return null;
  return {
    name: `${group}:${artifact}`,
    ecosystem: 'maven',
    declaredVersion: version === undefined || version.length === 0 ? undefined : version,
    kind,
  };
}

function dedup(deps: Dependency[]): Dependency[] {
  const seen = new Set<string>();
  const out: Dependency[] = [];
  for (const d of deps) {
    const k = `${d.name}|${d.ecosystem}|${d.kind ?? 'runtime'}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

export function parseBuildGradle(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  const cleaned = stripComments(source);
  const includeDev = opts?.includeDev === true;

  const out: Dependency[] = [];

  const collectShorthand = (configs: readonly string[], kind: 'runtime' | 'dev'): void => {
    const re = buildShorthandRegex(configs);
    for (const m of cleaned.matchAll(re)) {
      const body = m[3];
      // body is either "g:a" or "g:a:v" — split on `:` from the right so
      // group ids that themselves contain `:` (rare but allowed) don't
      // mis-split. We expect 2 or 3 components.
      const parts = body.split(':');
      if (parts.length < 2 || parts.length > 4) continue;
      const group = parts[0];
      const artifact = parts[1];
      const version = parts.length >= 3 ? parts.slice(2).join(':') : undefined;
      const dep = makeDep(group, artifact, version, kind);
      if (dep) out.push(dep);
    }
  };

  const collectGroovyNamed = (configs: readonly string[], kind: 'runtime' | 'dev'): void => {
    const re = buildGroovyNamedArgRegex(configs);
    for (const m of cleaned.matchAll(re)) {
      const group = m[3];
      const artifact = m[5];
      const version = m[7];
      const dep = makeDep(group, artifact, version, kind);
      if (dep) out.push(dep);
    }
  };

  const collectKotlinNamed = (configs: readonly string[], kind: 'runtime' | 'dev'): void => {
    const re = buildKotlinNamedArgRegex(configs);
    for (const m of cleaned.matchAll(re)) {
      const group = m[3];
      const artifact = m[5];
      const version = m[7];
      const dep = makeDep(group, artifact, version, kind);
      if (dep) out.push(dep);
    }
  };

  collectShorthand(RUNTIME_CONFIGS, 'runtime');
  collectGroovyNamed(RUNTIME_CONFIGS, 'runtime');
  collectKotlinNamed(RUNTIME_CONFIGS, 'runtime');

  if (includeDev) {
    collectShorthand(DEV_CONFIGS, 'dev');
    collectGroovyNamed(DEV_CONFIGS, 'dev');
    collectKotlinNamed(DEV_CONFIGS, 'dev');
  }

  return dedup(out);
}

/**
 * Match plugin id declarations inside `plugins { ... }` blocks:
 *   id 'org.foo' version '1.0' (Groovy)
 *   id "org.foo"               (Groovy / Kotlin DSL no-version)
 *   id("org.foo") version("1.0") (Kotlin DSL)
 *   id("org.foo")              (Kotlin DSL no-version)
 *
 * The plugins block delimiter is NOT enforced — declarations elsewhere are
 * rare and would just yield extra plugin ids that the coords map either
 * matches or warn-logs as unmapped.
 */
const PLUGIN_GROOVY_RE = /\bid\s+(['"])([^'"]+?)\1(?:\s+version\s+(['"])([^'"]+?)\3)?/g;
const PLUGIN_KOTLIN_RE = /\bid\s*\(\s*(['"])([^'"]+?)\1\s*\)(?:\s+version\s*\(\s*(['"])([^'"]+?)\3\s*\))?/g;

export function extractPluginIds(source: string): Array<{ id: string; version?: string }> {
  const cleaned = stripComments(source);
  const out: Array<{ id: string; version?: string }> = [];
  const seen = new Set<string>();

  for (const m of cleaned.matchAll(PLUGIN_KOTLIN_RE)) {
    const id = m[2];
    const version = m[4];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, version });
  }
  for (const m of cleaned.matchAll(PLUGIN_GROOVY_RE)) {
    const id = m[2];
    const version = m[4];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, version });
  }

  return out;
}
