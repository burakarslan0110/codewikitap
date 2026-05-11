import { describe, it, expect } from 'vitest';

import { parseSettingsGradle } from '../../../src/adapters/manifests/settings_gradle.js';

describe('parseSettingsGradle', () => {
  it('extracts subprojects from Kotlin DSL include(...) calls', () => {
    const src = `rootProject.name = "x"\ninclude(":foo", ":bar:baz", ":qux")\n`;
    expect(parseSettingsGradle(src)).toEqual(['foo', 'bar/baz', 'qux']);
  });

  it('extracts subprojects from Groovy include with single-quoted strings', () => {
    const src = `include 'foo', ':bar:baz'\n`;
    expect(parseSettingsGradle(src)).toEqual(['foo', 'bar/baz']);
  });

  it('extracts subprojects from Groovy include with double-quoted strings', () => {
    const src = `include "foo", ":bar"\n`;
    expect(parseSettingsGradle(src)).toEqual(['foo', 'bar']);
  });

  it('strips line comments BEFORE matching', () => {
    const src = `// include(":commented-out")\ninclude(":real")\n`;
    expect(parseSettingsGradle(src)).toEqual(['real']);
  });

  it('strips block comments BEFORE matching', () => {
    const src = `/* include(":commented-out") */\ninclude(":real")\n`;
    expect(parseSettingsGradle(src)).toEqual(['real']);
  });

  it('handles multi-line include calls (Kotlin DSL)', () => {
    const src = `include(\n  ":a",\n  ":b"\n)\n`;
    expect(parseSettingsGradle(src)).toEqual(['a', 'b']);
  });

  it('returns empty array on a settings file with no include calls', () => {
    expect(parseSettingsGradle(`rootProject.name = "x"\n`)).toEqual([]);
  });

  it('does not extract include() calls that resemble project names but are part of unrelated functions', () => {
    // `includeBuild(...)` is a different Gradle directive (composite builds);
    // we only match `include(...)` / `include "..."` exactly.
    expect(parseSettingsGradle(`includeBuild("../sibling")\n`)).toEqual([]);
  });
});
