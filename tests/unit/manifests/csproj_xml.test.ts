import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCsprojXml } from '../../../src/adapters/manifests/csproj_xml.js';
import { ManifestError } from '../../../src/types.js';

const FIX = (name: string): string =>
  readFileSync(resolve(__dirname, '../../fixtures/manifests', name), 'utf8');

describe('parseCsprojXml', () => {
  it('extracts PackageReference entries with attribute Version', () => {
    const deps = parseCsprojXml(FIX('MyApp.csproj'));
    const names = deps.map((d) => d.name);
    expect(names).toContain('Newtonsoft.Json');
    expect(names).toContain('Serilog');
    expect(names).toContain('Polly');

    const newton = deps.find((d) => d.name === 'Newtonsoft.Json');
    expect(newton?.declaredVersion).toBe('13.0.3');
    expect(newton?.ecosystem).toBe('nuget');
    expect(newton?.kind).toBe('runtime');
  });

  it('extracts PackageReference entries with child <Version> element', () => {
    const deps = parseCsprojXml(FIX('MyApp.csproj'));
    const polly = deps.find((d) => d.name === 'Polly');
    expect(polly?.declaredVersion).toBe('8.2.0');
  });

  it('emits declaredVersion=undefined when no version is present (CPM-style csproj)', () => {
    const deps = parseCsprojXml(FIX('MyApp-cpm.csproj'));
    const newton = deps.find((d) => d.name === 'Newtonsoft.Json');
    expect(newton).toBeDefined();
    expect(newton?.declaredVersion).toBeUndefined();
  });

  it('tags PrivateAssets="all" as kind=dev and filters by default', () => {
    // Default: dev entries excluded
    const noDev = parseCsprojXml(FIX('MyApp.csproj'));
    expect(noDev.find((d) => d.name === 'Microsoft.SourceLink.GitHub')).toBeUndefined();

    // includeDev: true → present with kind=dev
    const withDev = parseCsprojXml(FIX('MyApp.csproj'), { includeDev: true });
    const sourceLink = withDev.find((d) => d.name === 'Microsoft.SourceLink.GitHub');
    expect(sourceLink).toBeDefined();
    expect(sourceLink?.kind).toBe('dev');
    expect(sourceLink?.declaredVersion).toBe('8.0.0');
  });

  it('skips <Reference> and <ProjectReference> entries', () => {
    const deps = parseCsprojXml(FIX('MyApp.csproj'), { includeDev: true });
    const names = deps.map((d) => d.name);
    expect(names).not.toContain('System.Web');
    expect(names).not.toContain('..\\Sibling\\Sibling.csproj');
  });

  it('returns sorted output', () => {
    const deps = parseCsprojXml(FIX('MyApp.csproj'), { includeDev: true });
    const names = deps.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });

  it('throws ManifestError(parse_error) when <Project> root is missing', () => {
    try {
      parseCsprojXml('<NotAProject/>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).kind).toBe('parse_error');
    }
  });
});
