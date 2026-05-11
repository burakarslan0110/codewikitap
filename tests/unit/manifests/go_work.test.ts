import { describe, it, expect } from 'vitest';

import { parseGoWork } from '../../../src/adapters/manifests/go_work.js';

describe('parseGoWork', () => {
  it('extracts use directives from a use(...) block', () => {
    const src = `go 1.22\n\nuse (\n\t./modA\n\t./modB\n)\n`;
    expect(parseGoWork(src)).toEqual(['./modA', './modB']);
  });

  it('extracts single-line use directive', () => {
    const src = `go 1.22\n\nuse ./modSingle\n`;
    expect(parseGoWork(src)).toEqual(['./modSingle']);
  });

  it('mixes single-line and block forms', () => {
    const src = `use ./alone\n\nuse (\n\t./first\n\t./second\n)\n`;
    expect(parseGoWork(src)).toEqual(['./alone', './first', './second']);
  });

  it('strips line comments and ignores other directives (replace, exclude, toolchain)', () => {
    const src = `go 1.22\n// comment\nuse (\n\t./real\n\t// ./commented-out\n)\nreplace example.com/x => ./local\nexclude example.com/y v1.0.0\ntoolchain go1.22.0\n`;
    expect(parseGoWork(src)).toEqual(['./real']);
  });

  it('returns empty array on a go.work with no use directives', () => {
    expect(parseGoWork(`go 1.22\n`)).toEqual([]);
  });

  it('handles trailing comments on use lines', () => {
    const src = `use (\n\t./modA // local copy\n\t./modB\n)\n`;
    expect(parseGoWork(src)).toEqual(['./modA', './modB']);
  });
});
