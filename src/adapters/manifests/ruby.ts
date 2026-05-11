/**
 * Ruby manifest parsers — `Gemfile.lock` (preferred, deterministic) and
 * `Gemfile` (regex DSL fallback for lock-less repos).
 *
 * Pure: takes a string, returns a Dependency[]. No I/O.
 *
 * v2.3 scope:
 *   - parseGemfileLock: line-by-line state machine over the DEPENDENCIES
 *     section. The lockfile's GEM/PATH/PLATFORMS/BUNDLED WITH sections are
 *     ignored (transitives live under GEM specs:; we never emit them).
 *   - parseGemfile: tightly-anchored regex captures name + optional version.
 *     Group inference uses a do/end stack with `group :development do` /
 *     `group :test do` / `group :development, :test do` recognition.
 *     Mitigated by the lock-preferred policy — the regex path only fires
 *     when no Gemfile.lock is present.
 *   - opts.includeDev=false (default) filters out dev-tagged gems.
 *
 * Output is sorted by `name` for determinism.
 */

import { Dependency } from '../../types.js';
import { getLogger } from '../../logging.js';

const LOCK_DEP_RE = /^ {2}([A-Za-z0-9_.-]+)(?: \(([^)]+)\))?(!)?$/;
const GEMFILE_GEM_RE = /^\s*gem\s+['"]([A-Za-z0-9_.-]+)['"](?:\s*,\s*['"]([^'"]*)['"])?/;
const GROUP_DO_RE = /^\s*group\s+((?::[a-z_]+(?:\s*,\s*:[a-z_]+)*))\s+do\b/;
const GENERIC_DO_RE = /\bdo\b(\s*\|[^|]*\|)?\s*$/;
const END_RE = /^\s*end\b/;
const SYMBOL_RE = /:([a-z_]+)/g;

export function parseGemfileLock(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  // Lockfile DEPENDENCIES are always direct user deps (no test/dev distinction
  // in lockfiles — Bundler doesn't record group context). Treat all as runtime.
  // opts.includeDev has no effect on lockfile parsing; documented in JSDoc.
  void opts;

  const out: Dependency[] = [];
  let inDeps = false;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!inDeps) {
      if (line.trim() === 'DEPENDENCIES') inDeps = true;
      continue;
    }
    // Exit conditions: blank line OR start of next ALL-CAPS section header.
    if (line.trim() === '' || /^[A-Z]/.test(line)) {
      inDeps = false;
      continue;
    }
    const m = LOCK_DEP_RE.exec(line);
    if (!m) continue;
    const [, name, version] = m;
    out.push({
      name,
      ecosystem: 'gem',
      declaredVersion: version || undefined,
      kind: 'runtime',
    });
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export function parseGemfile(
  source: string,
  opts?: { includeDev?: boolean },
): Dependency[] {
  const includeDev = opts?.includeDev === true;
  const log = getLogger();
  let unrecognizedDoWarned = false;
  let unbalancedEndWarned = false;

  // Stack tracks the kind context for nested do-blocks. Initial 'runtime'
  // is the implicit top-level scope.
  const stack: Array<'runtime' | 'dev'> = ['runtime'];
  const out: Dependency[] = [];

  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // Match `gem 'name' [, 'version']` first (before do/end so a gem line
    // with a trailing block — rare but valid — still emits the gem).
    const gemMatch = GEMFILE_GEM_RE.exec(line);
    if (gemMatch) {
      const [, name, version] = gemMatch;
      const kind = stack[stack.length - 1];
      if (!includeDev && kind === 'dev') continue;
      out.push({
        name,
        ecosystem: 'gem',
        declaredVersion: version || undefined,
        kind,
      });
      continue;
    }

    // `end` first (so `group ... do; ...; end` lines are unambiguous).
    if (END_RE.test(trimmed)) {
      if (stack.length > 1) {
        stack.pop();
      } else if (!unbalancedEndWarned) {
        log.warn('gemfile_unbalanced_end', {});
        unbalancedEndWarned = true;
      }
      continue;
    }

    // `group :sym(, :sym)* do` — recognized group-block opener.
    const groupMatch = GROUP_DO_RE.exec(line);
    if (groupMatch) {
      const symbols = collectSymbols(groupMatch[1]);
      const isDev = symbols.some((s) => s === 'development' || s === 'test');
      stack.push(isDev ? 'dev' : 'runtime');
      continue;
    }

    // Other `do` block (helper, configure, etc.) — preserve current kind so
    // any inner `gem` declarations inherit the surrounding scope. Warn once
    // per scan so users know coverage may have degraded for unusual patterns.
    if (GENERIC_DO_RE.test(line)) {
      stack.push(stack[stack.length - 1]);
      if (!unrecognizedDoWarned) {
        log.warn('gemfile_unrecognized_do_block', {});
        unrecognizedDoWarned = true;
      }
      continue;
    }
  }

  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function collectSymbols(syms: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  SYMBOL_RE.lastIndex = 0;
  while ((m = SYMBOL_RE.exec(syms)) !== null) {
    out.push(m[1]);
  }
  return out;
}

