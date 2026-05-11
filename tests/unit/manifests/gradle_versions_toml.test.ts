import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseGradleVersionsToml } from '../../../src/adapters/manifests/gradle_versions_toml.js';
import { ManifestError } from '../../../src/types.js';

const FIX = (name: string): string =>
  readFileSync(resolve(__dirname, '../../fixtures/manifests', name), 'utf8');

describe('parseGradleVersionsToml', () => {
  it('parses string-form library entries and emits maven-coord names', () => {
    const deps = parseGradleVersionsToml(FIX('gradle/libs.versions.toml'));
    const guava = deps.find((d) => d.name === 'com.google.guava:guava');
    expect(guava).toBeDefined();
    expect(guava?.declaredVersion).toBe('33.0.0-jre');
    expect(guava?.ecosystem).toBe('maven');
    expect(guava?.kind).toBe('runtime');
  });

  it('parses module/version table form', () => {
    const deps = parseGradleVersionsToml(FIX('gradle/libs.versions.toml'));
    const jackson = deps.find((d) => d.name === 'com.fasterxml.jackson.core:jackson-databind');
    expect(jackson?.declaredVersion).toBe('2.16.0');
  });

  it('resolves version.ref against [versions]', () => {
    const deps = parseGradleVersionsToml(FIX('gradle/libs.versions.toml'));
    const ktor = deps.find((d) => d.name === 'io.ktor:ktor-server-core');
    expect(ktor?.declaredVersion).toBe('2.3.7'); // versions.ktor

    const kotlin = deps.find((d) => d.name === 'org.jetbrains.kotlin:kotlin-stdlib');
    expect(kotlin?.declaredVersion).toBe('1.9.21');
  });

  it('parses group/name/version split form', () => {
    const deps = parseGradleVersionsToml(FIX('gradle/libs.versions.toml'));
    const slf4j = deps.find((d) => d.name === 'org.slf4j:slf4j-api');
    expect(slf4j?.declaredVersion).toBe('2.0.9');
  });

  it('emits declaredVersion=undefined for unresolved version.ref', () => {
    const deps = parseGradleVersionsToml(FIX('gradle/libs.versions.toml'));
    const mystery = deps.find((d) => d.name === 'org.example:mystery');
    expect(mystery).toBeDefined();
    expect(mystery?.declaredVersion).toBeUndefined();
  });

  it('skips [bundles] section + does not emit raw plugin ids as dep names', () => {
    const deps = parseGradleVersionsToml(FIX('gradle/libs.versions.toml'));
    // Plugin id never appears as a dep name verbatim — v2.5 resolves
    // mapped plugins to their coord; unmapped are skipped with warn.
    expect(deps.find((d) => d.name === 'org.jetbrains.kotlin.jvm')).toBeUndefined();
    expect(deps.find((d) => d.name.includes('ktor') && d.name === 'ktor')).toBeUndefined();
  });

  it('v2.5: resolves mapped [plugins] entries to their groupId:artifactId coord', () => {
    const src = `
[versions]
kotlin = "1.9.22"

[plugins]
kt = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
boot = { id = "org.springframework.boot", version = "3.2.0" }
unmapped = { id = "com.example.does-not-exist", version = "1.0" }
`;
    const deps = parseGradleVersionsToml(src);
    const ktDep = deps.find((d) => d.name === 'org.jetbrains.kotlin:kotlin-gradle-plugin');
    expect(ktDep).toBeDefined();
    expect(ktDep?.declaredVersion).toBe('1.9.22');
    expect(ktDep?.kind).toBe('runtime');

    const bootDep = deps.find((d) => d.name === 'org.springframework.boot:spring-boot-gradle-plugin');
    expect(bootDep).toBeDefined();
    expect(bootDep?.declaredVersion).toBe('3.2.0');

    // Unmapped plugin emits no dep (warn-once was emitted; not asserted here).
    expect(deps.find((d) => d.name.includes('does-not-exist'))).toBeUndefined();
  });

  it('returns deps sorted by name for determinism', () => {
    const deps = parseGradleVersionsToml(FIX('gradle/libs.versions.toml'));
    const names = deps.map((d) => d.name);
    expect(names).toEqual([...names].sort());
  });

  it('throws ManifestError(parse_error) on malformed TOML', () => {
    expect(() => parseGradleVersionsToml('[libraries\nfoo = "x"\n')).toThrow(ManifestError);
  });
});
