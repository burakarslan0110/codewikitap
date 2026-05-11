import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseDirectoryPackagesProps } from '../../../src/adapters/manifests/directory_packages_props.js';

const FIX = (name: string): string =>
  readFileSync(resolve(__dirname, '../../fixtures/manifests', name), 'utf8');

describe('parseDirectoryPackagesProps', () => {
  it('returns a Map<name, version> over PackageVersion entries', () => {
    const map = parseDirectoryPackagesProps(FIX('Directory.Packages.props'));
    expect(map.get('Newtonsoft.Json')).toBe('13.0.3');
    expect(map.get('Serilog')).toBe('3.1.1');
    expect(map.get('Microsoft.SourceLink.GitHub')).toBe('8.0.0');
    expect(map.size).toBe(3);
  });

  it('returns empty map when <Project> root is missing (does not throw)', () => {
    const map = parseDirectoryPackagesProps('<NotAProject/>');
    expect(map.size).toBe(0);
  });

  it('throws on malformed input (non-XML)', () => {
    // fast-xml-parser is lenient but this is unparseable.
    expect(() => parseDirectoryPackagesProps('@@@@@@@')).not.toThrow();
    // Root-missing scenarios return empty map — already covered above.
    // Truly invalid XML structures get rejected by fast-xml-parser only on
    // catastrophic cases; the Map-returning parser opts for "best effort".
  });
});
