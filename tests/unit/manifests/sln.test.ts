import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseSln } from '../../../src/adapters/manifests/sln.js';

const FIX = (name: string): string =>
  readFileSync(resolve(__dirname, '../../fixtures/manifests', name), 'utf8');

describe('parseSln', () => {
  it('extracts only csproj relative paths (filters fsproj, vbproj, solution folders)', () => {
    const csprojs = parseSln(FIX('sln-with-csprojs/MyApp.sln'));
    // Solution folder + fsproj should be filtered. Two csprojs remain.
    expect(csprojs).toHaveLength(2);
    // Path separators normalized to forward slashes.
    expect(csprojs).toContain('src/Proj1/Proj1.csproj');
    expect(csprojs).toContain('src/Proj2/Proj2.csproj');
  });

  it('handles Windows line endings', () => {
    const sln =
      'Microsoft Visual Studio Solution File, Format Version 12.00\r\n' +
      'Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "P", "Proj\\P.csproj", "{aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa}"\r\n' +
      'EndProject\r\n';
    const csprojs = parseSln(sln);
    expect(csprojs).toEqual(['Proj/P.csproj']);
  });

  it('returns empty array on a sln with no csproj entries', () => {
    const sln =
      'Microsoft Visual Studio Solution File, Format Version 12.00\n' +
      'Global\nEndGlobal\n';
    expect(parseSln(sln)).toEqual([]);
  });

  it('does NOT throw on malformed input', () => {
    expect(() => parseSln('not a real sln file at all')).not.toThrow();
    expect(parseSln('not a real sln file at all')).toEqual([]);
  });
});
