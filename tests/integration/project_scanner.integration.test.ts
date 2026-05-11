import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

import { scanProject } from '../../src/services/project_scanner.js';
import { ManifestError } from '../../src/types.js';

let tmpDir: string;

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codewiki-mcp-scan-'));
}

beforeEach(() => {
  tmpDir = mkTmp();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scanProject — happy paths', () => {
  it('finds package.json at the immediate CWD', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'x', version: '1.0.0', dependencies: { lodash: '^4.0.0' },
    }));
    const r = scanProject(tmpDir);
    expect(r.projectRoot).toBe(tmpDir);
    expect(r.manifestType).toBe('package.json');
    expect(r.dependencies.map((d) => d.name)).toEqual(['lodash']);
  });

  it('walks up to find a manifest several levels above the CWD', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
      name: 'x', version: '1.0.0', dependencies: { react: '^19.0.0' },
    }));
    const deep = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });

    const r = scanProject(deep);
    expect(r.projectRoot).toBe(tmpDir);
    expect(r.dependencies.map((d) => d.name)).toEqual(['react']);
  });

  it('returns null structure when no manifest exists in any parent', () => {
    // tmpDir is empty. Use a directory we are SURE won't have a manifest
    // anywhere up the tree (the OS tmp parent doesn't have one).
    const r = scanProject(tmpDir);
    expect(r.projectRoot).toBeNull();
    expect(r.manifestType).toBeNull();
    expect(r.dependencies).toEqual([]);
  });

  it('respects MANIFEST_PRIORITY (canonical tier): go.mod > pyproject.toml > package.json (v2.2+) > requirements.txt (aux)', () => {
    // v2.2 reordered MANIFEST_PRIORITY so canonical/language-uniquely-identifying
    // manifests win over the polyglot package.json. v2.4 keeps that order.
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { a: '1' } }));
    fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\ndependencies = ["b"]\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'c\n');
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module x\n\nrequire d v1.0.0\n');

    const r = scanProject(tmpDir);
    expect(r.manifestType).toBe('go.mod');
    expect(r.dependencies.map((d) => d.name)).toEqual(['d']);
  });
});

describe('scanProject — adversarial hardening', () => {
  it('rejects a symlink at the manifest path (no follow in v1)', () => {
    const realFile = path.join(tmpDir, 'real-package.json');
    fs.writeFileSync(realFile, '{}');
    const symlink = path.join(tmpDir, 'package.json');
    fs.symlinkSync(realFile, symlink);

    expect(() => scanProject(tmpDir)).toThrow(ManifestError);
    try {
      scanProject(tmpDir);
    } catch (e) {
      expect((e as ManifestError).kind).toBe('unsafe_manifest');
    }
  });

  it('rejects a FIFO at the manifest path', () => {
    const fifoPath = path.join(tmpDir, 'package.json');
    try {
      execSync(`mkfifo ${JSON.stringify(fifoPath)}`);
    } catch {
      return; // mkfifo not available — skip on platforms that don't support it
    }
    expect(() => scanProject(tmpDir)).toThrow(ManifestError);
    try {
      scanProject(tmpDir);
    } catch (e) {
      expect((e as ManifestError).kind).toBe('unsafe_manifest');
    }
  });

  it('rejects an oversized manifest without reading the entire file', () => {
    const big = path.join(tmpDir, 'package.json');
    // 2 MB of nul-padded text — well over the 1 MB cap.
    const buf = Buffer.alloc(2 * 1024 * 1024, ' ');
    fs.writeFileSync(big, buf);
    expect(() => scanProject(tmpDir)).toThrow(ManifestError);
    try {
      scanProject(tmpDir);
    } catch (e) {
      expect((e as ManifestError).kind).toBe('manifest_too_large');
    }
  });

  it('rejects a manifest whose contents contain a NUL byte (UTF-16 BOM signal)', () => {
    const utf16 = path.join(tmpDir, 'package.json');
    // UTF-16 LE BOM + ASCII chars — every other byte is NUL.
    const bom = Buffer.from([0xff, 0xfe]);
    const payload = Buffer.from('{"x":1}', 'utf16le');
    fs.writeFileSync(utf16, Buffer.concat([bom, payload]));
    expect(() => scanProject(tmpDir)).toThrow(ManifestError);
    try {
      scanProject(tmpDir);
    } catch (e) {
      expect((e as ManifestError).kind).toBe('invalid_encoding');
    }
  });
});
