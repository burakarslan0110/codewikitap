import { describe, it, expect } from 'vitest';

import { parseBuildGradle, extractPluginIds } from '../../../src/adapters/manifests/build_gradle.js';

describe('parseBuildGradle — Groovy single-quote string-shorthand', () => {
  it('extracts implementation g:a:v with single quotes', () => {
    const src = `
      dependencies {
        implementation 'org.springframework:spring-core:6.1.1'
        implementation 'com.fasterxml.jackson.core:jackson-databind:2.16.0'
      }
    `;
    const deps = parseBuildGradle(src);
    expect(deps).toHaveLength(2);
    expect(deps).toContainEqual({
      name: 'org.springframework:spring-core',
      ecosystem: 'maven',
      declaredVersion: '6.1.1',
      kind: 'runtime',
    });
    expect(deps).toContainEqual({
      name: 'com.fasterxml.jackson.core:jackson-databind',
      ecosystem: 'maven',
      declaredVersion: '2.16.0',
      kind: 'runtime',
    });
  });
});

describe('parseBuildGradle — Groovy double-quote string-shorthand', () => {
  it('extracts implementation g:a:v with double quotes', () => {
    const src = `dependencies { implementation "org.example:foo:1.2.3" }`;
    const deps = parseBuildGradle(src);
    expect(deps).toEqual([
      { name: 'org.example:foo', ecosystem: 'maven', declaredVersion: '1.2.3', kind: 'runtime' },
    ]);
  });
});

describe('parseBuildGradle — Kotlin DSL function-call form', () => {
  it('extracts implementation("g:a:v")', () => {
    const src = `dependencies {
      implementation("org.example:foo:1.2.3")
      api("org.example:bar:4.5.6")
    }`;
    const deps = parseBuildGradle(src);
    expect(deps).toContainEqual({
      name: 'org.example:foo',
      ecosystem: 'maven',
      declaredVersion: '1.2.3',
      kind: 'runtime',
    });
    expect(deps).toContainEqual({
      name: 'org.example:bar',
      ecosystem: 'maven',
      declaredVersion: '4.5.6',
      kind: 'runtime',
    });
  });
});

describe('parseBuildGradle — Groovy named-arg map form', () => {
  it('extracts implementation group: g, name: a, version: v', () => {
    const src = `dependencies {
      implementation group: 'org.example', name: 'foo', version: '1.2.3'
      implementation group: "org.other", name: "bar", version: "4.5.6"
    }`;
    const deps = parseBuildGradle(src);
    expect(deps).toContainEqual({
      name: 'org.example:foo',
      ecosystem: 'maven',
      declaredVersion: '1.2.3',
      kind: 'runtime',
    });
    expect(deps).toContainEqual({
      name: 'org.other:bar',
      ecosystem: 'maven',
      declaredVersion: '4.5.6',
      kind: 'runtime',
    });
  });
});

describe('parseBuildGradle — Kotlin DSL named-arg form', () => {
  it('extracts implementation(group = g, name = a, version = v)', () => {
    const src = `dependencies {
      implementation(group = "org.example", name = "foo", version = "1.2.3")
    }`;
    const deps = parseBuildGradle(src);
    expect(deps).toEqual([
      { name: 'org.example:foo', ecosystem: 'maven', declaredVersion: '1.2.3', kind: 'runtime' },
    ]);
  });
});

describe('parseBuildGradle — no-version form', () => {
  it('extracts g:a without version (declaredVersion undefined)', () => {
    const src = `dependencies {
      implementation 'org.example:foo'
      implementation("org.example:bar")
    }`;
    const deps = parseBuildGradle(src);
    expect(deps).toContainEqual({
      name: 'org.example:foo',
      ecosystem: 'maven',
      declaredVersion: undefined,
      kind: 'runtime',
    });
    expect(deps).toContainEqual({
      name: 'org.example:bar',
      ecosystem: 'maven',
      declaredVersion: undefined,
      kind: 'runtime',
    });
  });
});

describe('parseBuildGradle — configurations', () => {
  it('classifies test* configurations as dev (gated by includeDev)', () => {
    const src = `dependencies {
      implementation 'a:b:1'
      testImplementation 'c:d:2'
      testCompileOnly 'e:f:3'
      androidTestImplementation 'g:h:4'
    }`;

    const runtimeOnly = parseBuildGradle(src);
    expect(runtimeOnly).toEqual([
      { name: 'a:b', ecosystem: 'maven', declaredVersion: '1', kind: 'runtime' },
    ]);

    const withDev = parseBuildGradle(src, { includeDev: true });
    const names = withDev.map((d) => d.name);
    expect(names).toContain('a:b');
    expect(names).toContain('c:d');
    expect(names).toContain('e:f');
    expect(names).toContain('g:h');
    expect(withDev.find((d) => d.name === 'c:d')?.kind).toBe('dev');
  });

  it('recognizes api/compileOnly/runtimeOnly as runtime', () => {
    const src = `dependencies {
      api 'a:b:1'
      compileOnly 'c:d:2'
      runtimeOnly 'e:f:3'
    }`;
    const deps = parseBuildGradle(src);
    expect(deps.map((d) => d.name).sort()).toEqual(['a:b', 'c:d', 'e:f']);
    expect(deps.every((d) => d.kind === 'runtime')).toBe(true);
  });
});

describe('parseBuildGradle — comments and unrecognized forms', () => {
  it('strips line // and block /* */ comments before matching', () => {
    const src = `dependencies {
      // commented out
      implementation 'kept:lib:1.0.0'
      /* implementation 'dropped:lib:2.0.0' */
      // implementation 'also-dropped:lib:3.0.0'
    }`;
    const deps = parseBuildGradle(src);
    expect(deps).toEqual([
      { name: 'kept:lib', ecosystem: 'maven', declaredVersion: '1.0.0', kind: 'runtime' },
    ]);
  });

  it('produces NO output for variable interpolation (intentional v2.5 gap)', () => {
    const src = `dependencies {
      implementation "org.springframework:spring-core:\${springVersion}"
      implementation "org.example:other:$libsVersion"
    }`;
    const deps = parseBuildGradle(src);
    expect(deps).toEqual([]);
  });

  it('produces NO output for ext-block / variable refs (intentional v2.5 gap)', () => {
    const src = `dependencies {
      implementation deps.spring
      implementation libs.jackson
    }`;
    const deps = parseBuildGradle(src);
    expect(deps).toEqual([]);
  });

  it('returns [] on empty input', () => {
    expect(parseBuildGradle('')).toEqual([]);
    expect(parseBuildGradle('// only comments\n/* nothing */')).toEqual([]);
  });
});

describe('parseBuildGradle — never evaluates code', () => {
  it('does not execute groovy/kotlin even when source contains exec-like expressions', () => {
    // If the parser ever evaluated source, ANY of these would throw or
    // mutate global state. Pure regex must just produce zero matches.
    const src = `
      throw new RuntimeException('bang')
      System.exit(1)
      dependencies {
        if (true) { implementation 'should-not-extract:foo:1.0.0' }
      }
    `;
    // Conditional blocks are NOT recognized — the dep inside the if/else is
    // still extracted by the linear regex (we don't track block nesting).
    // The point of THIS test is "no code execution" — running the parser
    // returns normally without throwing.
    expect(() => parseBuildGradle(src)).not.toThrow();
  });
});

describe('extractPluginIds — Groovy DSL', () => {
  it('extracts id with version from Groovy plugins block', () => {
    const src = `plugins {
      id 'org.springframework.boot' version '3.2.0'
      id 'java'
    }`;
    const plugins = extractPluginIds(src);
    expect(plugins).toContainEqual({ id: 'org.springframework.boot', version: '3.2.0' });
    expect(plugins).toContainEqual({ id: 'java', version: undefined });
  });
});

describe('extractPluginIds — Kotlin DSL', () => {
  it('extracts id("X") version("Y") from Kotlin plugins block', () => {
    const src = `plugins {
      id("org.jetbrains.kotlin.jvm") version("1.9.22")
      id("java")
    }`;
    const plugins = extractPluginIds(src);
    expect(plugins).toContainEqual({ id: 'org.jetbrains.kotlin.jvm', version: '1.9.22' });
    expect(plugins).toContainEqual({ id: 'java', version: undefined });
  });
});
