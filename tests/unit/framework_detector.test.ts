import { describe, it, expect } from 'vitest';

import { detectFrameworks } from '../../src/services/framework_detector.js';
import type { Dependency } from '../../src/types.js';

function dep(name: string, ecosystem: Dependency['ecosystem']): Dependency {
  return { name, ecosystem };
}

describe('detectFrameworks', () => {
  it('detects next.js from a single npm dep with confidence:high + correct sourceRepo', () => {
    const r = detectFrameworks([dep('next', 'npm'), dep('react', 'npm')], 'package.json');
    const names = r.map((f) => f.name).sort();
    expect(names).toContain('next.js');
    const nextEntry = r.find((f) => f.name === 'next.js')!;
    expect(nextEntry.confidence).toBe('high');
    expect(nextEntry.sourceRepo).toBe('vercel/next.js');
    expect(nextEntry.detectedFrom).toMatch(/^package\.json:dependencies\.next$/);
  });

  it('detects Spring Boot from a starter-* prefix match and dedupes multi-starter inputs to ONE FrameworkContext', () => {
    const deps: Dependency[] = [
      dep('org.springframework.boot:spring-boot-starter-web', 'maven'),
      dep('org.springframework.boot:spring-boot-starter-data-jpa', 'maven'),
      dep('com.fasterxml.jackson.core:jackson-databind', 'maven'),
    ];
    const r = detectFrameworks(deps, 'pom.xml');
    const springEntries = r.filter((f) => f.name === 'Spring Boot');
    expect(springEntries).toHaveLength(1);
    expect(springEntries[0].confidence).toBe('high');
    expect(springEntries[0].sourceRepo).toBe('spring-projects/spring-boot');
    // detectedFrom references the FIRST matching dep
    expect(springEntries[0].detectedFrom).toContain('spring-boot-starter-web');
  });

  it('does NOT false-positive on near-name deps (substring guard)', () => {
    // `nextjs-bcrypt`, `django-cors-headers` look like the framework name but aren't.
    const r = detectFrameworks([
      dep('nextjs-bcrypt', 'npm'),
      dep('django-cors-headers', 'pypi'),
    ], 'package.json');
    expect(r.map((f) => f.name)).not.toContain('next.js');
    expect(r.map((f) => f.name)).not.toContain('Django');
  });

  it('returns empty array for empty deps', () => {
    expect(detectFrameworks([], 'package.json')).toEqual([]);
  });

  it('returns empty array for deps with no signature match', () => {
    const r = detectFrameworks([dep('lodash', 'npm'), dep('chalk', 'npm')], 'package.json');
    expect(r).toEqual([]);
  });

  it('detects multiple distinct frameworks from a single manifest (next + nestjs combo)', () => {
    const r = detectFrameworks([
      dep('next', 'npm'),
      dep('@nestjs/core', 'npm'),
    ], 'package.json');
    const names = r.map((f) => f.name).sort();
    expect(names).toEqual(['NestJS', 'next.js']);
  });

  it('respects ecosystem boundary — same name in different ecosystem MUST NOT cross-match', () => {
    // `django` is a PyPI signature. An npm package coincidentally named "django"
    // must NOT trigger the Django framework match.
    const r = detectFrameworks([dep('django', 'npm')], 'package.json');
    expect(r.map((f) => f.name)).not.toContain('Django');
  });

  it('detects Go module via full vanity path (gin)', () => {
    const r = detectFrameworks([dep('github.com/gin-gonic/gin', 'go')], 'go.mod');
    expect(r.map((f) => f.name)).toContain('Gin');
    const ginEntry = r.find((f) => f.name === 'Gin')!;
    expect(ginEntry.sourceRepo).toBe('gin-gonic/gin');
  });

  it('emits medium confidence for runtime-only signatures (tokio)', () => {
    const r = detectFrameworks([dep('tokio', 'cargo')], 'Cargo.toml');
    const tokioEntry = r.find((f) => f.name === 'Tokio');
    expect(tokioEntry).toBeDefined();
    expect(tokioEntry!.confidence).toBe('medium');
  });

  it('matchKind is ecosystem-driven, not manifestType-driven — empty manifestType still detects', () => {
    // Reviewer suggestion: confirm match contract is purely on (ecosystem, name)
    // so a defensive empty-string manifestType from the caller does not break
    // detection (the detectedFrom string is still emitted, just with an empty
    // prefix).
    const r = detectFrameworks([dep('next', 'npm')], '');
    const nextEntry = r.find((f) => f.name === 'next.js');
    expect(nextEntry).toBeDefined();
    expect(nextEntry!.detectedFrom).toBe(':dependencies.next');
  });
});
