import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parsePomXml, extractBomImports } from '../../../src/adapters/manifests/pom_xml.js';
import { ManifestError } from '../../../src/types.js';

const FIX = (name: string): string =>
  readFileSync(resolve(__dirname, '../../fixtures/manifests', name), 'utf8');

describe('parsePomXml', () => {
  it('returns runtime deps with explicit and inherited versions, skipping test-scoped by default', () => {
    const deps = parsePomXml(FIX('pom.xml'));
    const names = deps.map((d) => d.name);
    expect(names).toContain('com.fasterxml.jackson.core:jackson-databind');
    expect(names).toContain('org.springframework:spring-core');
    expect(names).not.toContain('org.junit.jupiter:junit-jupiter'); // test scope excluded
    expect(names).not.toContain('com.example.local:my-tool'); // system scope skipped

    const jackson = deps.find((d) => d.name === 'com.fasterxml.jackson.core:jackson-databind');
    expect(jackson?.declaredVersion).toBe('2.16.0');
    expect(jackson?.kind).toBe('runtime');
    expect(jackson?.ecosystem).toBe('maven');

    // v2.4: ${spring.version} now resolves against <properties> map (was undefined in v2.3).
    const spring = deps.find((d) => d.name === 'org.springframework:spring-core');
    expect(spring?.declaredVersion).toBe('6.1.0');
  });

  it('emits test-scoped deps with kind=dev when opts.includeDev is true', () => {
    const deps = parsePomXml(FIX('pom.xml'), { includeDev: true });
    const junit = deps.find((d) => d.name === 'org.junit.jupiter:junit-jupiter');
    expect(junit).toBeDefined();
    expect(junit?.kind).toBe('dev');
    expect(junit?.declaredVersion).toBe('5.10.0');
  });

  it('inherits versions from <dependencyManagement> when <dependency> omits version', () => {
    const deps = parsePomXml(FIX('pom-with-management.xml'));
    const jackson = deps.find((d) => d.name === 'com.fasterxml.jackson.core:jackson-databind');
    expect(jackson?.declaredVersion).toBe('2.16.0');

    const slf4j = deps.find((d) => d.name === 'org.slf4j:slf4j-api');
    expect(slf4j?.declaredVersion).toBe('2.0.9');

    // dependencyManagement entries are NOT emitted on their own
    expect(deps.length).toBe(2);
  });

  it('parses aggregator pom (<packaging>pom</packaging> with <modules>) without traversing modules', () => {
    const deps = parsePomXml(FIX('pom-aggregator.xml'));
    // The aggregator's own <dependencies> ARE parsed.
    const guava = deps.find((d) => d.name === 'com.google.guava:guava');
    expect(guava).toBeDefined();
    expect(guava?.declaredVersion).toBe('33.0.0-jre');
    // No module-traversal output (modules/core, modules/web NOT walked)
    expect(deps.length).toBe(1);
  });

  it('returns deps sorted by name for determinism', () => {
    const deps = parsePomXml(FIX('pom.xml'), { includeDev: true });
    const names = deps.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });

  it('throws ManifestError(parse_error) when <project> root is missing', () => {
    try {
      parsePomXml('<settings/>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).kind).toBe('parse_error');
    }
  });

  // v2.4: property reference resolution -----------------------------------

  describe('v2.4 property reference resolution', () => {
    it('resolves forward references — property A using property B declared LATER in same block', () => {
      const deps = parsePomXml(FIX('pom-with-forward-property-ref.xml'));
      const spring = deps.find((d) => d.name === 'org.springframework:spring-core');
      // ${spring.version} -> ${spring-boot.version} -> "3.2.0" (one indirection allowed)
      expect(spring?.declaredVersion).toBe('3.2.0');
    });

    it('resolves built-in ${project.version} against the local <version> element', () => {
      const deps = parsePomXml(FIX('pom-with-forward-property-ref.xml'));
      const self = deps.find((d) => d.name === 'com.example:self-version');
      expect(self?.declaredVersion).toBe('1.0.0');
    });

    it('resolves built-in ${parent.version} against the <parent> block', () => {
      const deps = parsePomXml(FIX('pom-with-forward-property-ref.xml'));
      const parent = deps.find((d) => d.name === 'com.example.parent:parent-version');
      expect(parent?.declaredVersion).toBe('2.5.0');
    });

    it('emits undefined for unknown properties (back-compat with v2.3)', () => {
      const deps = parsePomXml(FIX('pom-with-forward-property-ref.xml'));
      const unknown = deps.find((d) => d.name === 'com.example:unknown-prop');
      expect(unknown?.declaredVersion).toBeUndefined();
    });

    it('emits undefined for two-deep property chains (one indirection ceiling, no hang)', () => {
      const deps = parsePomXml(FIX('pom-with-forward-property-ref.xml'));
      // chain.a -> chain.b -> chain.c. Only one indirection: a -> b. b's value is "${chain.c}",
      // which is itself a token; that's the SECOND hop and v2.4 stops there -> undefined.
      const twoDeep = deps.find((d) => d.name === 'com.example:two-deep');
      expect(twoDeep?.declaredVersion).toBeUndefined();
    });

    it('emits undefined on circular references without hanging', () => {
      const deps = parsePomXml(FIX('pom-with-circular-property.xml'));
      const circ = deps.find((d) => d.name === 'com.example:circular');
      expect(circ?.declaredVersion).toBeUndefined();
    });
  });
});

// v2.4: BOM import detection (sibling export) -----------------------------

describe('extractBomImports', () => {
  it('emits BOM imports declared in <dependencyManagement> with property-resolved versions', () => {
    const boms = extractBomImports(FIX('pom-with-bom-import-spring.xml'));
    expect(boms).toEqual([
      { groupId: 'org.springframework.boot', artifactId: 'spring-boot-dependencies', version: '3.2.0' },
    ]);
  });

  it('drops BOM imports whose version cannot be resolved (still a ${...} token)', () => {
    const boms = extractBomImports(FIX('pom-with-broken-bom-import.xml'));
    expect(boms).toEqual([]);
  });

  it('returns an empty array when no BOM imports are declared', () => {
    const boms = extractBomImports(FIX('pom.xml'));
    expect(boms).toEqual([]);
  });

  it('does not emit non-import dependencyManagement entries as BOM imports', () => {
    // pom-with-bom-import-spring.xml has both an import-scoped BOM AND a regular
    // <dependencyManagement> entry. Only the import-scoped one is a BOM import.
    const boms = extractBomImports(FIX('pom-with-bom-import-spring.xml'));
    expect(boms.length).toBe(1);
    expect(boms[0].artifactId).toBe('spring-boot-dependencies');
  });

  it('throws ManifestError(parse_error) when <project> root is missing', () => {
    try {
      extractBomImports('<settings/>');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).kind).toBe('parse_error');
    }
  });
});
