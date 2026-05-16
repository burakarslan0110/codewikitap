import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const TESTS_UNIT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS_DIR = path.resolve(TESTS_UNIT_DIR, '..', '..', 'src', 'installer', 'adapters');

// All assertions below will fail until the installer modules exist.
// This file is the unit-test class for the installer feature (per the testing
// parsimony rule: 1 unit test class + 1 integration test class).

import {
  atomicWrite,
  backupIfExists,
  deepMergeJson,
  tildeExpand,
} from '../../src/installer/io.js';
import {
  InstallerError,
  type Scope,
  type AdapterReadResult,
} from '../../src/installer/adapter.js';
import { parseArgs, type ParsedArgs, assertStdioGuard } from '../../src/installer/cli.js';
import { runWizard, formatDiff, type WizardDeps } from '../../src/installer/wizard.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-test-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('installer/io.ts', () => {
  describe('atomicWrite', () => {
    it('writes content to the target path', async () => {
      const target = path.join(tmpRoot, 'nested', 'config.json');
      await atomicWrite(target, '{"hello":"world"}');
      const read = await fs.readFile(target, 'utf8');
      expect(read).toBe('{"hello":"world"}');
    });

    it('creates parent directories as needed', async () => {
      const target = path.join(tmpRoot, 'a', 'b', 'c', 'config.json');
      await atomicWrite(target, 'x');
      expect((await fs.stat(target)).isFile()).toBe(true);
    });

    it('leaves no .tmp residue after success', async () => {
      const target = path.join(tmpRoot, 'config.json');
      await atomicWrite(target, 'x');
      const siblings = await fs.readdir(tmpRoot);
      expect(siblings.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('uses a unique tmp suffix per call (PID + random)', async () => {
      // Spy on rename to capture the staging filenames we used.
      const target = path.join(tmpRoot, 'shared.json');
      const seen = new Set<string>();
      const orig = fs.rename.bind(fs);
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        seen.add(String(from));
        return orig(from, to);
      });
      try {
        await Promise.all([
          atomicWrite(target, 'A'),
          atomicWrite(target, 'B'),
        ]);
      } finally {
        spy.mockRestore();
      }
      expect(seen.size).toBe(2); // two distinct staging files
    });

    it('concurrent writes: final content equals exactly one input (never mixed)', async () => {
      const target = path.join(tmpRoot, 'shared.json');
      const a = 'AAAAAAAA';
      const b = 'BBBBBBBB';
      await Promise.all([atomicWrite(target, a), atomicWrite(target, b)]);
      const read = await fs.readFile(target, 'utf8');
      expect([a, b]).toContain(read);
    });

    // Typed error surfaces with actionable messages.
    it('throws path_create_failed when parent mkdir fails (EACCES surrogate)', async () => {
      const { InstallerError } = await import('../../src/installer/adapter.js');
      const spy = vi.spyOn(fs, 'mkdir').mockRejectedValue(
        Object.assign(new Error('access denied'), { code: 'EACCES' }),
      );
      try {
        await expect(atomicWrite(path.join(tmpRoot, 'a/b/c.json'), 'x')).rejects.toMatchObject({
          kind: 'path_create_failed',
        });
        // Also verify error type:
        try {
          await atomicWrite(path.join(tmpRoot, 'a/b/c.json'), 'x');
        } catch (err) {
          expect(err).toBeInstanceOf(InstallerError);
          expect((err as Error).message).toContain('EACCES');
          expect((err as Error).message).toContain('a/b'); // path embedded in message
        }
      } finally {
        spy.mockRestore();
      }
    });

    it('retries rename ONCE on EBUSY before surfacing home_not_writable', async () => {
      const target = path.join(tmpRoot, 'busy.json');
      let calls = 0;
      const orig = fs.rename.bind(fs);
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        calls++;
        if (calls <= 2) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return orig(from, to);
      });
      try {
        await expect(atomicWrite(target, 'x')).rejects.toMatchObject({
          kind: 'home_not_writable',
        });
        expect(calls).toBe(2); // first attempt + 1 retry
      } finally {
        spy.mockRestore();
      }
    });

    it('rename retry: EBUSY then success → write completes', async () => {
      const target = path.join(tmpRoot, 'transient-busy.json');
      let calls = 0;
      const orig = fs.rename.bind(fs);
      const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        calls++;
        if (calls === 1) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return orig(from, to);
      });
      try {
        await atomicWrite(target, 'recovered');
        expect(await fs.readFile(target, 'utf8')).toBe('recovered');
        expect(calls).toBe(2); // attempt + retry
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('backupIfExists', () => {
    it('returns null when the source file does not exist', async () => {
      const target = path.join(tmpRoot, 'missing.json');
      const out = await backupIfExists(target);
      expect(out).toBeNull();
    });

    it('writes <path>.bak when no prior backup exists', async () => {
      const target = path.join(tmpRoot, 'config.json');
      await fs.writeFile(target, 'original');
      const out = await backupIfExists(target);
      expect(out).toBe(`${target}.bak`);
      expect(await fs.readFile(`${target}.bak`, 'utf8')).toBe('original');
    });

    it('preserves the ORIGINAL .bak when called twice (second goes to .bak.<timestamp>)', async () => {
      const target = path.join(tmpRoot, 'config.json');
      await fs.writeFile(target, 'first');
      const first = await backupIfExists(target);
      expect(first).toBe(`${target}.bak`);
      await fs.writeFile(target, 'second');
      const second = await backupIfExists(target);
      expect(second).not.toBe(`${target}.bak`);
      expect(second?.startsWith(`${target}.bak.`)).toBe(true);
      // Original .bak still has the FIRST content.
      expect(await fs.readFile(`${target}.bak`, 'utf8')).toBe('first');
      expect(await fs.readFile(second!, 'utf8')).toBe('second');
    });
  });

  describe('deepMergeJson', () => {
    it('sets a nested key, creating intermediate objects', () => {
      const into = {};
      const out = deepMergeJson(into, 'mcpServers.codewikitap', { command: 'npx' });
      expect(out).toEqual({ mcpServers: { codewikitap: { command: 'npx' } } });
    });

    it('preserves sibling keys at every level', () => {
      const into = { mcpServers: { other: { command: 'node', args: ['o.js'] } } };
      const out = deepMergeJson(into, 'mcpServers.codewikitap', {
        command: 'npx',
        args: ['-y', 'codewikitap'],
      });
      expect(out).toEqual({
        mcpServers: {
          other: { command: 'node', args: ['o.js'] },
          codewikitap: { command: 'npx', args: ['-y', 'codewikitap'] },
        },
      });
    });

    it('overwrites an existing leaf value at the dotted key', () => {
      const into = { mcpServers: { codewikitap: { command: 'old' } } };
      const out = deepMergeJson(into, 'mcpServers.codewikitap', { command: 'npx' });
      expect((out as { mcpServers: { codewikitap: { command: string } } }).mcpServers.codewikitap).toEqual({ command: 'npx' });
    });

    it('throws if traversal encounters a non-object value mid-path', () => {
      const into = { mcpServers: 'oops' };
      expect(() => deepMergeJson(into, 'mcpServers.codewikitap', { x: 1 })).toThrow(
        InstallerError,
      );
    });

    it('handles single-segment keys (`mcp.<name>` style with one dot)', () => {
      const into = {};
      const out = deepMergeJson(into, 'mcp.codewikitap', {
        type: 'local',
        command: 'npx',
        args: ['-y', 'codewikitap'],
      });
      expect(out).toEqual({
        mcp: {
          codewikitap: { type: 'local', command: 'npx', args: ['-y', 'codewikitap'] },
        },
      });
    });
  });

  describe('tildeExpand', () => {
    it('expands a leading ~ to homedir()', () => {
      expect(tildeExpand('~/foo')).toBe(path.join(os.homedir(), 'foo'));
    });

    it('expands a bare ~ to homedir()', () => {
      expect(tildeExpand('~')).toBe(os.homedir());
    });

    it('leaves absolute paths unchanged', () => {
      expect(tildeExpand('/etc/foo')).toBe('/etc/foo');
    });

    it('leaves relative paths unchanged', () => {
      expect(tildeExpand('foo/bar')).toBe('foo/bar');
    });
  });

  describe('InstallerError', () => {
    it('carries a discriminated `kind` field', () => {
      const e = new InstallerError('stdio_guard_violation', 'oops');
      expect(e.kind).toBe('stdio_guard_violation');
      expect(e.message).toBe('oops');
      expect(e).toBeInstanceOf(Error);
    });
  });

  describe('cli.parseArgs', () => {
    it('returns kind=help on --help', () => {
      const out = parseArgs(['--help']);
      expect(out.kind).toBe('help');
    });

    it('returns kind=help on -h', () => {
      const out = parseArgs(['-h']);
      expect(out.kind).toBe('help');
    });

    it('parses --target=<id> and --scope=<scope>', () => {
      const out = parseArgs(['--target=claude-code', '--scope=user']);
      expect(out).toEqual<ParsedArgs>({
        kind: 'run',
        target: 'claude-code',
        scope: 'user',
        yes: false,
        dryRun: false,
      });
    });

    it('parses space-separated flag values: --target claude-code --scope project', () => {
      const out = parseArgs(['--target', 'claude-code', '--scope', 'project']);
      expect(out).toEqual<ParsedArgs>({
        kind: 'run',
        target: 'claude-code',
        scope: 'project',
        yes: false,
        dryRun: false,
      });
    });

    it('parses --yes and --dry-run as booleans', () => {
      const out = parseArgs(['--yes', '--dry-run']);
      expect(out).toEqual<ParsedArgs>({
        kind: 'run',
        target: undefined,
        scope: undefined,
        yes: true,
        dryRun: true,
      });
    });

    it('rejects unknown flags with kind=error', () => {
      const out = parseArgs(['--bogus']);
      expect(out.kind).toBe('error');
      if (out.kind === 'error') expect(out.code).toBe(2);
    });

    it('rejects --scope=foo (invalid scope)', () => {
      const out = parseArgs(['--target=claude-code', '--scope=machine']);
      expect(out.kind).toBe('error');
      if (out.kind === 'error') expect(out.code).toBe(2);
    });
  });

  describe('adapters/json common shape', () => {
    // We assert each JSON `mcpServers` adapter produces the byte-identical
    // canonical entry on a fresh write, and preserves an unrelated entry on
    // a re-write. Parametrized over all targets sharing the shape.
    const cases = [
      { id: 'claude-code', cwdRel: '.mcp.json', homeRel: '.claude/mcp.json' },
      { id: 'cursor', cwdRel: '.cursor/mcp.json', homeRel: '.cursor/mcp.json' },
      { id: 'gemini-cli', cwdRel: '.gemini/settings.json', homeRel: '.gemini/settings.json' },
      { id: 'qwen-code', cwdRel: '.qwen/settings.json', homeRel: '.qwen/settings.json' },
      { id: 'antigravity', cwdRel: null, homeRel: '.gemini/antigravity/mcp_config.json' },
      { id: 'windsurf', cwdRel: null, homeRel: '.codeium/windsurf/mcp_config.json' },
    ] as const;

    for (const c of cases) {
      describe(c.id, () => {
        it('pathFor(user) resolves under home', async () => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === c.id);
          expect(adapter).toBeDefined();
          const p = adapter!.pathFor('user', { home: tmpRoot, cwd: tmpRoot });
          expect(p).toBe(path.join(tmpRoot, c.homeRel));
        });

        if (c.cwdRel) {
          it('pathFor(project) resolves under cwd', async () => {
            const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
            const adapter = ADAPTERS.find((a) => a.id === c.id);
            const p = adapter!.pathFor('project', { home: tmpRoot, cwd: tmpRoot });
            expect(p).toBe(path.join(tmpRoot, c.cwdRel!));
          });
        } else {
          it('does NOT support project scope', async () => {
            const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
            const adapter = ADAPTERS.find((a) => a.id === c.id);
            expect(adapter!.supportedScopes).not.toContain('project');
            expect(adapter!.supportedScopes).toContain('user');
          });
        }

        it('serialize(merge(missing)) produces canonical mcpServers entry', async () => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === c.id)!;
          const result = adapter.serialize(
            adapter.merge({ status: 'missing' }, { command: 'npx', args: ['-y', 'codewikitap'] }),
          );
          const parsed = JSON.parse(result);
          expect(parsed).toEqual({
            mcpServers: { codewikitap: { command: 'npx', args: ['-y', 'codewikitap'] } },
          });
          // 2-space indent
          expect(result).toContain('  "mcpServers"');
        });

        it('serialize(merge(parsed)) preserves unrelated entries', async () => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === c.id)!;
          const result = adapter.serialize(
            adapter.merge(
              { status: 'parsed', value: { mcpServers: { other: { command: 'node', args: ['o.js'] } } } },
              { command: 'npx', args: ['-y', 'codewikitap'] },
            ),
          );
          const parsed = JSON.parse(result);
          expect(parsed).toEqual({
            mcpServers: {
              other: { command: 'node', args: ['o.js'] },
              codewikitap: { command: 'npx', args: ['-y', 'codewikitap'] },
            },
          });
        });

        it('read() returns status:missing for a path that does not exist', async () => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === c.id)!;
          const out = await adapter.read(path.join(tmpRoot, 'absent.json'));
          expect(out.status).toBe('missing');
        });

        it('read() returns status:parse_error on malformed JSON', async () => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === c.id)!;
          const file = path.join(tmpRoot, 'bad.json');
          await fs.writeFile(file, '{not valid json');
          const out = await adapter.read(file);
          expect(out.status).toBe('parse_error');
          if (out.status === 'parse_error') {
            expect(out.raw).toBe('{not valid json');
          }
        });
      });
    }
  });

  describe('adapters/codex-cli (TOML)', () => {
    it('user-scope only', async () => {
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const adapter = ADAPTERS.find((a) => a.id === 'codex-cli')!;
      expect(adapter.supportedScopes).toEqual(['user']);
    });

    it('pathFor(user) → ~/.codex/config.toml relative to ctx.home', async () => {
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const adapter = ADAPTERS.find((a) => a.id === 'codex-cli')!;
      expect(adapter.pathFor('user', { home: tmpRoot, cwd: tmpRoot })).toBe(
        path.join(tmpRoot, '.codex/config.toml'),
      );
    });

    it('serialize produces valid TOML with [mcp_servers.codewikitap] table', async () => {
      const { parse } = await import('@iarna/toml');
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const adapter = ADAPTERS.find((a) => a.id === 'codex-cli')!;
      const out = adapter.serialize(
        adapter.merge({ status: 'missing' }, { command: 'npx', args: ['-y', 'codewikitap'] }),
      );
      const parsed = parse(out) as { mcp_servers: { codewikitap: { command: string; args: string[] } } };
      expect(parsed.mcp_servers.codewikitap.command).toBe('npx');
      expect(parsed.mcp_servers.codewikitap.args).toEqual(['-y', 'codewikitap']);
    });

    it('merge() recovers from parse_error by emitting a fresh-write TOML', async () => {
      // The wizard prompts the user before reaching this branch (wizard.ts
      // parse_error path), and backupIfExists runs first so the corrupt file
      // survives in .bak. This test locks the recovery contract: merge() on
      // a parse_error input must NOT throw and must serialize to a fresh-shape
      // TOML containing only the canonical entry.
      const { parse } = await import('@iarna/toml');
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const adapter = ADAPTERS.find((a) => a.id === 'codex-cli')!;
      const merged = adapter.merge(
        { status: 'parse_error', raw: 'bad = =', reason: 'malformed toml' },
        { command: 'npx', args: ['-y', 'codewikitap'] },
      );
      const out = adapter.serialize(merged);
      const parsed = parse(out) as { mcp_servers: { codewikitap: { command: string; args: string[] } } };
      expect(parsed.mcp_servers.codewikitap).toEqual({
        command: 'npx',
        args: ['-y', 'codewikitap'],
      });
    });

    it('preserves unrelated TOML sections on re-write', async () => {
      const { parse } = await import('@iarna/toml');
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const adapter = ADAPTERS.find((a) => a.id === 'codex-cli')!;
      const existing = '[some_other_section]\nkey = "value"\n';
      const file = path.join(tmpRoot, 'config.toml');
      await fs.writeFile(file, existing);
      const read = await adapter.read(file);
      const merged = adapter.merge(read, { command: 'npx', args: ['-y', 'codewikitap'] });
      const out = adapter.serialize(merged);
      const parsed = parse(out) as { some_other_section: { key: string }; mcp_servers: { codewikitap: unknown } };
      expect(parsed.some_other_section.key).toBe('value');
      expect(parsed.mcp_servers.codewikitap).toBeDefined();
    });
  });

  describe('cross-platform paths', () => {
    describe('opencode user scope', () => {
      it.each(['linux', 'darwin'] as const)(
        '%s: respects XDG_CONFIG_HOME when set',
        async (platform) => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
          const xdg = path.join(tmpRoot, 'xdg-custom');
          const resolved = adapter.pathFor('user', {
            home: tmpRoot,
            cwd: tmpRoot,
            platform,
            env: { XDG_CONFIG_HOME: xdg },
          });
          expect(resolved).toBe(path.join(xdg, 'opencode', 'opencode.json'));
        },
      );

      it.each(['linux', 'darwin'] as const)(
        '%s: falls back to <home>/.config when XDG_CONFIG_HOME unset',
        async (platform) => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
          const resolved = adapter.pathFor('user', {
            home: tmpRoot,
            cwd: tmpRoot,
            platform,
            env: {},
          });
          expect(resolved).toBe(path.join(tmpRoot, '.config', 'opencode', 'opencode.json'));
        },
      );

      it.each(['linux', 'darwin'] as const)(
        '%s: falls back to <home>/.config when XDG_CONFIG_HOME is empty string',
        async (platform) => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
          const resolved = adapter.pathFor('user', {
            home: tmpRoot,
            cwd: tmpRoot,
            platform,
            env: { XDG_CONFIG_HOME: '' },
          });
          expect(resolved).toBe(path.join(tmpRoot, '.config', 'opencode', 'opencode.json'));
        },
      );

      it('win32: respects APPDATA when set', async () => {
        const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
        const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
        const appData = path.join(tmpRoot, 'AppData', 'Roaming');
        const resolved = adapter.pathFor('user', {
          home: tmpRoot,
          cwd: tmpRoot,
          platform: 'win32',
          env: { APPDATA: appData },
        });
        expect(resolved).toBe(path.join(appData, 'opencode', 'opencode.json'));
      });

      it('win32: falls back to <home>/AppData/Roaming when APPDATA unset', async () => {
        const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
        const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
        const resolved = adapter.pathFor('user', {
          home: tmpRoot,
          cwd: tmpRoot,
          platform: 'win32',
          env: {},
        });
        expect(resolved).toBe(path.join(tmpRoot, 'AppData', 'Roaming', 'opencode', 'opencode.json'));
      });
    });

    describe('opencode project scope', () => {
      it.each(['linux', 'darwin', 'win32'] as const)(
        '%s: returns <cwd>/opencode.json',
        async (platform) => {
          const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
          const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
          const resolved = adapter.pathFor('project', {
            home: tmpRoot,
            cwd: tmpRoot,
            platform,
            env: {},
          });
          expect(resolved).toBe(path.join(tmpRoot, 'opencode.json'));
        },
      );
    });

    describe('home-anchored adapters carry no platform branch', () => {
      // Reads each non-opencode adapter source file and asserts the
      // substrings 'ctx.platform', 'ctx.env', and 'process.platform' are
      // ABSENT. Locks the invariant that these adapters stay home-only —
      // a future engineer adding a platform branch flips this red.
      const HOME_ANCHORED = [
        'claude_code.ts',
        'cursor.ts',
        'codex_cli.ts',
        'gemini_cli.ts',
        'qwen_code.ts',
        'windsurf.ts',
        'antigravity.ts',
      ] as const;

      it.each(HOME_ANCHORED)(
        '%s does not reference ctx.platform / ctx.env / process.platform',
        async (file) => {
          const source = await fs.readFile(path.join(ADAPTERS_DIR, file), 'utf8');
          expect(source).not.toMatch(/ctx\.platform/);
          expect(source).not.toMatch(/ctx\.env/);
          expect(source).not.toMatch(/process\.platform/);
        },
      );

      it('platform-aware adapters (opencode, vscode) are NOT in HOME_ANCHORED', () => {
        // Reverse-form lock: prevents a future engineer from "fixing" a test
        // failure by accidentally adding a platform-aware adapter to this
        // list, which would silently disable the platform-branch invariant.
        expect(HOME_ANCHORED).not.toContain('opencode.ts');
        expect(HOME_ANCHORED).not.toContain('vscode.ts');
      });
    });
  });

  describe('adapters/opencode (mcp.<name> + type:"local")', () => {
    it('pathFor(project) → opencode.json (cwd); pathFor(user, linux, no XDG) → ~/.config/opencode/opencode.json', async () => {
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
      expect(adapter.pathFor('project', { home: tmpRoot, cwd: tmpRoot, platform: 'linux', env: {} })).toBe(
        path.join(tmpRoot, 'opencode.json'),
      );
      expect(adapter.pathFor('user', { home: tmpRoot, cwd: tmpRoot, platform: 'linux', env: {} })).toBe(
        path.join(tmpRoot, '.config/opencode/opencode.json'),
      );
    });

    it('serialize produces { mcp: { codewikitap: { type: "local", ... } } }', async () => {
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const adapter = ADAPTERS.find((a) => a.id === 'opencode')!;
      const out = adapter.serialize(
        adapter.merge({ status: 'missing' }, { command: 'npx', args: ['-y', 'codewikitap'] }),
      );
      const parsed = JSON.parse(out);
      expect(parsed).toEqual({
        mcp: {
          codewikitap: { type: 'local', command: 'npx', args: ['-y', 'codewikitap'] },
        },
      });
      // critical: NOT mcpServers
      expect(parsed.mcpServers).toBeUndefined();
    });
  });

  describe('adapters/vscode (servers.<name> + type:"stdio")', () => {
    it('id, displayName, and supportedScopes are correct', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      expect(vscode.id).toBe('vscode');
      expect(vscode.displayName).toBe('Visual Studio Code');
      expect(vscode.supportedScopes).toEqual(expect.arrayContaining(['project', 'user']));
      expect(vscode.supportedScopes).toHaveLength(2);
    });

    it.each(['linux', 'darwin', 'win32'] as const)(
      '%s: pathFor(project) → <cwd>/.vscode/mcp.json',
      async (platform) => {
        const { vscode } = await import('../../src/installer/adapters/vscode.js');
        expect(
          vscode.pathFor('project', { home: tmpRoot, cwd: tmpRoot, platform, env: {} }),
        ).toBe(path.join(tmpRoot, '.vscode', 'mcp.json'));
      },
    );

    it('linux: pathFor(user) honors XDG_CONFIG_HOME when set', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const xdg = path.join(tmpRoot, 'xdg-custom');
      const resolved = vscode.pathFor('user', {
        home: tmpRoot,
        cwd: tmpRoot,
        platform: 'linux',
        env: { XDG_CONFIG_HOME: xdg },
      });
      expect(resolved).toBe(path.join(xdg, 'Code', 'User', 'mcp.json'));
    });

    it('linux: pathFor(user) falls back to <home>/.config when XDG unset', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const resolved = vscode.pathFor('user', {
        home: tmpRoot,
        cwd: tmpRoot,
        platform: 'linux',
        env: {},
      });
      expect(resolved).toBe(path.join(tmpRoot, '.config', 'Code', 'User', 'mcp.json'));
    });

    it('linux: pathFor(user) falls back to <home>/.config when XDG is empty string', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const resolved = vscode.pathFor('user', {
        home: tmpRoot,
        cwd: tmpRoot,
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '' },
      });
      expect(resolved).toBe(path.join(tmpRoot, '.config', 'Code', 'User', 'mcp.json'));
    });

    it('darwin: pathFor(user) → <home>/Library/Application Support/Code/User/mcp.json (IGNORES XDG_CONFIG_HOME)', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      // Pass XDG_CONFIG_HOME — must be ignored on darwin (locks divergence from opencode).
      const resolved = vscode.pathFor('user', {
        home: tmpRoot,
        cwd: tmpRoot,
        platform: 'darwin',
        env: { XDG_CONFIG_HOME: '/should/be/ignored' },
      });
      expect(resolved).toBe(
        path.join(tmpRoot, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      );
    });

    it('win32: pathFor(user) honors APPDATA when set', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const appData = path.join(tmpRoot, 'AppData', 'Roaming');
      const resolved = vscode.pathFor('user', {
        home: tmpRoot,
        cwd: tmpRoot,
        platform: 'win32',
        env: { APPDATA: appData },
      });
      expect(resolved).toBe(path.join(appData, 'Code', 'User', 'mcp.json'));
    });

    it('win32: pathFor(user) falls back to <home>/AppData/Roaming when APPDATA unset', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const resolved = vscode.pathFor('user', {
        home: tmpRoot,
        cwd: tmpRoot,
        platform: 'win32',
        env: {},
      });
      expect(resolved).toBe(
        path.join(tmpRoot, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'),
      );
    });

    it('serialize produces { servers: { codewikitap: { type: "stdio", ... } } }', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const out = vscode.serialize(
        vscode.merge({ status: 'missing' }, { command: 'npx', args: ['-y', 'codewikitap'] }),
      );
      const parsed = JSON.parse(out);
      expect(parsed).toEqual({
        servers: {
          codewikitap: { type: 'stdio', command: 'npx', args: ['-y', 'codewikitap'] },
        },
      });
      // critical: NOT mcpServers, NOT mcp
      expect(parsed.mcpServers).toBeUndefined();
      expect(parsed.mcp).toBeUndefined();
    });

    it('merge preserves unrelated servers.other entries on re-write', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const out = vscode.serialize(
        vscode.merge(
          { status: 'parsed', value: { servers: { other: { type: 'stdio', command: 'node', args: ['o.js'] } } } },
          { command: 'npx', args: ['-y', 'codewikitap'] },
        ),
      );
      const parsed = JSON.parse(out);
      expect(parsed).toEqual({
        servers: {
          other: { type: 'stdio', command: 'node', args: ['o.js'] },
          codewikitap: { type: 'stdio', command: 'npx', args: ['-y', 'codewikitap'] },
        },
      });
    });

    it('read() returns status:missing for an absent file (sanity: delegates to readJsonFile)', async () => {
      const { vscode } = await import('../../src/installer/adapters/vscode.js');
      const out = await vscode.read(path.join(tmpRoot, 'absent.json'));
      expect(out.status).toBe('missing');
    });

    it('source file references ctx.platform (positive lock: must NOT be home-anchored)', async () => {
      // Reverse-form of the HOME_ANCHORED test. If a future change removes the
      // platform branching from vscode.ts (making it accidentally home-anchored)
      // this test fails — catching the regression in EITHER direction.
      const source = await fs.readFile(path.join(ADAPTERS_DIR, 'vscode.ts'), 'utf8');
      expect(source).toMatch(/ctx\.platform/);
    });
  });

  describe('wizard.runWizard (headless)', () => {
    // The wizard normally opens readline against process.stdin. Tests pass a
    // `WizardDeps` shim that fakes home/cwd and lets us spy on prompt/backup
    // call sites without touching the user's filesystem.
    function mkDeps(over: Partial<WizardDeps> = {}): WizardDeps {
      const argv = ['node', '/path', 'install']; // stdio guard satisfied
      return {
        home: tmpRoot,
        cwd: tmpRoot,
        stderr: vi.fn(),
        stdout: vi.fn(),
        createReadlineFn: vi.fn(() => {
          throw new Error('readline must NOT be opened in headless mode');
        }),
        argv,
        ...over,
      };
    }

    it('fresh install with --target + --scope + --yes writes the canonical entry', async () => {
      const deps = mkDeps();
      await runWizard(
        { target: 'claude-code', scope: 'user', yes: true, dryRun: false },
        deps,
      );
      const written = await fs.readFile(path.join(tmpRoot, '.claude/mcp.json'), 'utf8');
      const parsed = JSON.parse(written);
      expect(parsed).toEqual({
        mcpServers: { codewikitap: { command: 'npx', args: ['-y', 'codewikitap'] } },
      });
      expect(deps.createReadlineFn).not.toHaveBeenCalled();
    });

    it('writes "[codewikitap] wrote <path>" to stderr (not stdout) on success', async () => {
      const stderr = vi.fn();
      const stdout = vi.fn();
      const deps = mkDeps({ stderr, stdout });
      await runWizard(
        { target: 'claude-code', scope: 'user', yes: true, dryRun: false },
        deps,
      );
      const stderrCalls = stderr.mock.calls.map((c) => String(c[0])).join('');
      const stdoutCalls = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(stderrCalls).toContain('[codewikitap] wrote');
      expect(stderrCalls).toContain(path.join(tmpRoot, '.claude/mcp.json'));
      expect(stdoutCalls).not.toContain('[codewikitap] wrote');
    });

    it('--dry-run prints the plan to stdout AND writes nothing AND creates no .bak', async () => {
      const stdout = vi.fn();
      const deps = mkDeps({ stdout });
      await runWizard(
        { target: 'claude-code', scope: 'user', yes: true, dryRun: true },
        deps,
      );
      const stdoutText = stdout.mock.calls.map((c) => String(c[0])).join('');
      expect(stdoutText).toContain(path.join(tmpRoot, '.claude/mcp.json'));
      expect(stdoutText).toContain('codewikitap');
      // No file written
      await expect(fs.access(path.join(tmpRoot, '.claude/mcp.json'))).rejects.toThrow();
      // No backup written (lazy-backup invariant)
      await expect(
        fs.access(path.join(tmpRoot, '.claude/mcp.json.bak')),
      ).rejects.toThrow();
    });

    it('preserves unrelated mcpServers entries on a re-write (TS-009 unit equivalent)', async () => {
      const target = path.join(tmpRoot, '.claude/mcp.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        JSON.stringify({ mcpServers: { other: { command: 'node', args: ['o.js'] } } }, null, 2),
      );
      await runWizard(
        { target: 'claude-code', scope: 'user', yes: true, dryRun: false },
        mkDeps(),
      );
      const out = JSON.parse(await fs.readFile(target, 'utf8'));
      expect(out.mcpServers.other).toEqual({ command: 'node', args: ['o.js'] });
      expect(out.mcpServers.codewikitap).toEqual({ command: 'npx', args: ['-y', 'codewikitap'] });
      // .bak created from prior content (TS-002 / TS-009 unit assertion)
      const bak = await fs.readFile(`${target}.bak`, 'utf8');
      expect(JSON.parse(bak).mcpServers.other).toEqual({ command: 'node', args: ['o.js'] });
    });

    it('throws unknown_target InstallerError when --target id is not registered', async () => {
      await expect(
        runWizard({ target: 'nope', scope: 'user', yes: true, dryRun: false }, mkDeps()),
      ).rejects.toMatchObject({ kind: 'unknown_target' });
    });

    it('throws unsupported_scope when --scope=project is used against a user-only adapter', async () => {
      await expect(
        runWizard({ target: 'windsurf', scope: 'project', yes: true, dryRun: false }, mkDeps()),
      ).rejects.toMatchObject({ kind: 'unsupported_scope' });
    });
  });

  describe('wizard.formatDiff', () => {
    it('produces a deterministic Current: / Proposed: block', () => {
      const current = { command: 'npx', args: ['-y', 'codewikitap@0.1.0'] };
      const proposed = { command: 'npx', args: ['-y', 'codewikitap'] };
      const text = formatDiff(current, proposed);
      expect(text).toContain('Current:');
      expect(text).toContain('Proposed:');
      expect(text).toContain('codewikitap@0.1.0');
      expect(text).toContain('"-y"');
      // Idempotent — calling twice with same inputs yields the same string
      expect(formatDiff(current, proposed)).toBe(text);
    });
  });

  describe('adapters/index.ts registry', () => {
    it('exports all 9 adapters with unique ids', async () => {
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const ids = ADAPTERS.map((a) => a.id);
      expect(ids).toHaveLength(9);
      expect(new Set(ids).size).toBe(9);
      expect(ids).toEqual(
        expect.arrayContaining([
          'claude-code',
          'cursor',
          'codex-cli',
          'gemini-cli',
          'qwen-code',
          'opencode',
          'windsurf',
          'antigravity',
          'vscode',
        ]),
      );
    });

    it('every adapter declares at least one supportedScope', async () => {
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      for (const a of ADAPTERS) {
        expect(a.supportedScopes.length).toBeGreaterThan(0);
      }
    });

    it('every adapter declares a keyPath; opencode and vscode are the documented exceptions', async () => {
      const { ADAPTERS } = await import('../../src/installer/adapters/index.js');
      const expected: Record<string, string> = {
        'claude-code': 'mcpServers.codewikitap',
        cursor: 'mcpServers.codewikitap',
        'codex-cli': 'mcpServers.codewikitap', // preserves pre-existing keyPathFor behavior; see Task 2 notes
        'gemini-cli': 'mcpServers.codewikitap',
        'qwen-code': 'mcpServers.codewikitap',
        windsurf: 'mcpServers.codewikitap',
        antigravity: 'mcpServers.codewikitap',
        opencode: 'mcp.codewikitap',
        vscode: 'servers.codewikitap',
      };
      for (const a of ADAPTERS) {
        expect(a.keyPath).toBe(expected[a.id]);
      }
    });

    it('keyPathFor symbol has been removed from wizard.ts (replaced by adapter.keyPath)', async () => {
      const wizardSrc = await fs.readFile(
        path.resolve(TESTS_UNIT_DIR, '..', '..', 'src', 'installer', 'wizard.ts'),
        'utf8',
      );
      expect(wizardSrc).not.toMatch(/function\s+keyPathFor/);
      expect(wizardSrc).not.toMatch(/keyPathFor\s*\(/);
    });
  });

  describe('cli.assertStdioGuard (defense-in-depth)', () => {
    it('throws InstallerError when argv[2] is not "install"', () => {
      const fakeArgv = ['node', '/path/to/dist/index.js'];
      expect(() => assertStdioGuard(fakeArgv)).toThrow(InstallerError);
      try {
        assertStdioGuard(fakeArgv);
      } catch (e) {
        expect(e).toBeInstanceOf(InstallerError);
        if (e instanceof InstallerError) expect(e.kind).toBe('stdio_guard_violation');
      }
    });

    it('throws when argv[2] is some other string', () => {
      expect(() =>
        assertStdioGuard(['node', '/path', 'something-else']),
      ).toThrow(InstallerError);
    });

    it('does not throw when argv[2] is "install"', () => {
      expect(() => assertStdioGuard(['node', '/path', 'install'])).not.toThrow();
    });
  });

  describe('AdapterReadResult discriminator', () => {
    it('compiles for all three branches (type-level smoke test)', () => {
      const a: AdapterReadResult = { status: 'missing' };
      const b: AdapterReadResult = { status: 'parsed', value: {} };
      const c: AdapterReadResult = { status: 'parse_error', raw: 'x', reason: 'bad' };
      expect([a.status, b.status, c.status]).toEqual(['missing', 'parsed', 'parse_error']);
    });

    it('Scope type accepts project + user', () => {
      const s: Scope = 'project';
      const u: Scope = 'user';
      expect([s, u]).toEqual(['project', 'user']);
    });
  });
});
