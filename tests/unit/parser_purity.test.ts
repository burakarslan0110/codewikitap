/**
 * v2.4 parser-purity guard — substring-scan belt-and-suspenders alongside the
 * ESLint `no-restricted-imports` / `no-restricted-globals` rules in
 * `eslint.config.js`. Asserts that NO file under `src/adapters/manifests/`
 * references network primitives. Manifest parsers must stay pure (file I/O
 * is allowed only via the scanner's `readManifestSafely`); BOM resolution
 * lives in `src/services/bom_resolver.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const PARSERS_DIR = resolve(__dirname, '../../src/adapters/manifests');

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bfetch\s*\(/, reason: 'fetch() call' },
  { pattern: /\bnode:https?\b/, reason: "node:http(s) import" },
  { pattern: /from\s+['"]https?['"]/, reason: 'http(s) module import' },
  { pattern: /from\s+['"]undici['"]/, reason: 'undici import' },
  { pattern: /from\s+['"]node-fetch['"]/, reason: 'node-fetch import' },
  { pattern: /\bnew\s+XMLHttpRequest\b/, reason: 'XMLHttpRequest' },
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('parser purity (src/adapters/manifests)', () => {
  const files = listTsFiles(PARSERS_DIR);

  it('finds manifest parser files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file.replace(PARSERS_DIR, 'manifests')} contains no network primitives`, () => {
      const source = readFileSync(file, 'utf8');
      const offenses: string[] = [];
      for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        if (pattern.test(source)) offenses.push(reason);
      }
      expect(offenses).toEqual([]);
    });
  }
});
