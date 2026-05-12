/**
 * Installer integration tests — spawn the built `dist/index.js install …`
 * as a subprocess against a tmp HOME and CWD, then assert filesystem
 * outcomes per TS-001..TS-009 from the plan.
 *
 * Each test does its own build-once-per-suite via beforeAll → ensures
 * dist/installer/* files exist (they would after a normal `pnpm build`).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const BIN = path.join(REPO_ROOT, 'dist', 'index.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  stdinInput?: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'install', ...args], {
      cwd,
      env,
      stdio: [stdinInput === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (stdinInput !== undefined && child.stdin) {
      child.stdin.write(stdinInput);
      child.stdin.end();
    }
  });
}

let tmpHome: string;
let tmpCwd: string;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  // Ensure dist is built. TSC is fast on incremental — runs ~1s.
  const r = spawnSync('node', ['./node_modules/typescript/bin/tsc'], { cwd: REPO_ROOT });
  if (r.status !== 0) {
    throw new Error(`pre-test build failed: ${r.stderr?.toString() ?? ''}`);
  }
}, 30_000);

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-int-home-'));
  tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-int-cwd-'));
  env = { ...process.env, HOME: tmpHome, CODEWIKI_SKIP_POSTINSTALL: '1' };
});

afterEach(async () => {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpCwd, { recursive: true, force: true });
});

describe('installer integration (TS-001..TS-009)', () => {
  describe('TS-001: Fresh install — Claude Code, user scope (interactive)', () => {
    it('writes ~/.claude/mcp.json and no .bak', async () => {
      const result = await run(
        [],
        env,
        tmpCwd,
        '1\n2\n', // target #1 (claude-code), scope #2 (user)
      );
      expect(result.code).toBe(0);
      const target = path.join(tmpHome, '.claude/mcp.json');
      const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
      expect(parsed.mcpServers.codewikitap).toEqual({
        command: 'npx',
        args: ['-y', 'codewikitap'],
      });
      await expect(fs.access(`${target}.bak`)).rejects.toThrow();
      expect(result.stderr).toContain('[codewikitap] wrote');
      expect(result.stderr).toContain(target);
    });
  });

  describe('TS-002: Existing codewikitap entry — overwrite (interactive)', () => {
    it('shows diff, writes new entry, creates .bak with prior content', async () => {
      const target = path.join(tmpHome, '.claude/mcp.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const stale = {
        mcpServers: { codewikitap: { command: 'npx', args: ['-y', 'codewikitap@0.1.0'] } },
      };
      await fs.writeFile(target, JSON.stringify(stale, null, 2));

      const result = await run(
        [],
        env,
        tmpCwd,
        '1\n2\no\n', // target #1, scope #2, overwrite
      );
      expect(result.code).toBe(0);
      // Diff blocks present in stdout
      expect(result.stdout).toContain('Current:');
      expect(result.stdout).toContain('Proposed:');
      expect(result.stdout).toContain('codewikitap@0.1.0');
      // New entry on disk
      const final = JSON.parse(await fs.readFile(target, 'utf8'));
      expect(final.mcpServers.codewikitap.args).toEqual(['-y', 'codewikitap']);
      // .bak matches pre-run state
      const bak = JSON.parse(await fs.readFile(`${target}.bak`, 'utf8'));
      expect(bak).toEqual(stale);
    });
  });

  describe('TS-003: Existing entry — skip', () => {
    it('leaves file byte-identical AND creates no .bak (lazy-backup invariant)', async () => {
      const target = path.join(tmpHome, '.claude/mcp.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const original = JSON.stringify(
        { mcpServers: { codewikitap: { command: 'npx', args: ['-y', 'codewikitap@0.1.0'] } } },
        null,
        2,
      );
      await fs.writeFile(target, original);

      const result = await run([], env, tmpCwd, '1\n2\ns\n'); // skip
      expect(result.code).toBe(0);
      expect(await fs.readFile(target, 'utf8')).toBe(original);
      await expect(fs.access(`${target}.bak`)).rejects.toThrow();
    });
  });

  describe('TS-004: Codex CLI TOML (headless, scope auto-resolves)', () => {
    it('writes ~/.codex/config.toml with [mcp_servers.codewikitap] table', async () => {
      const result = await run(
        ['--target=codex-cli', '--scope=user', '--yes'],
        env,
        tmpCwd,
      );
      expect(result.code).toBe(0);
      const target = path.join(tmpHome, '.codex/config.toml');
      const raw = await fs.readFile(target, 'utf8');
      expect(raw).toContain('[mcp_servers.codewikitap]');
      expect(raw).toContain('command = "npx"');
      expect(raw).toContain('"codewikitap"');
    });
  });

  describe('TS-005: opencode mcp.<name> + type:"local"', () => {
    it('writes opencode.json with mcp.codewikitap (not mcpServers) and type:"local"', async () => {
      const result = await run(
        ['--target=opencode', '--scope=project', '--yes'],
        env,
        tmpCwd,
      );
      expect(result.code).toBe(0);
      const target = path.join(tmpCwd, 'opencode.json');
      const parsed = JSON.parse(await fs.readFile(target, 'utf8'));
      expect(parsed).toEqual({
        mcp: {
          codewikitap: { type: 'local', command: 'npx', args: ['-y', 'codewikitap'] },
        },
      });
      expect(parsed.mcpServers).toBeUndefined();
    });
  });

  describe('TS-006: Headless flag overrides', () => {
    it('exits 0 within 5s with no prompt strings and writes the file', async () => {
      const start = Date.now();
      const result = await run(
        ['--target=claude-code', '--scope=project', '--yes'],
        env,
        tmpCwd,
      );
      const elapsed = Date.now() - start;
      expect(result.code).toBe(0);
      expect(elapsed).toBeLessThan(5_000);
      expect(result.stdout).not.toContain('Select target:');
      expect(result.stdout).not.toContain('Select scope:');
      const target = path.join(tmpCwd, '.mcp.json');
      expect(JSON.parse(await fs.readFile(target, 'utf8'))).toEqual({
        mcpServers: { codewikitap: { command: 'npx', args: ['-y', 'codewikitap'] } },
      });
    });
  });

  describe('TS-007: --dry-run prints plan, writes nothing, no .bak', () => {
    it('stdout contains target path + entry preview, no files written', async () => {
      const result = await run(
        ['--target=claude-code', '--scope=user', '--dry-run'],
        env,
        tmpCwd,
      );
      expect(result.code).toBe(0);
      const target = path.join(tmpHome, '.claude/mcp.json');
      expect(result.stdout).toContain(target);
      expect(result.stdout).toContain('codewikitap');
      await expect(fs.access(target)).rejects.toThrow();
      await expect(fs.access(`${target}.bak`)).rejects.toThrow();
    });
  });

  describe('TS-008: Non-TTY without required flags fails fast', () => {
    it('exits 2 with --target and --scope mentioned on stderr; no files written', async () => {
      const result = await run([], env, tmpCwd); // no stdin → ignore (non-TTY)
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--target');
      expect(result.stderr).toContain('--scope');
      const dotMcp = path.join(tmpCwd, '.mcp.json');
      await expect(fs.access(dotMcp)).rejects.toThrow();
    });
  });

  describe('Symlink invocation (regression: npx bin symlink + macOS /tmp symlink)', () => {
    // Repro for the v0.4.0 bug where `npx codewikitap install` silently
    // exited 0 with no output. Root cause: the bin-entry guard compared
    // `fileURLToPath(import.meta.url)` (real path) against `process.argv[1]`
    // (symlink path) directly, which is false negative when npx symlinks
    // the bin into node_modules/.bin/ OR when invoked through a path with
    // intermediate symlinks (macOS /tmp → /private/tmp). The fix wraps
    // argv[1] in fs.realpathSync before the compare. This test invokes
    // the bin through a fresh symlink to lock the regression.
    it('install --help works when invoked via a symlink to dist/index.js', async () => {
      const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'installer-link-'));
      const linkPath = path.join(linkDir, 'codewikitap-link');
      await fs.symlink(BIN, linkPath);
      try {
        const result = await new Promise<RunResult>((resolve, reject) => {
          const child = spawn(process.execPath, [linkPath, 'install', '--help'], {
            cwd: tmpCwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (b) => { stdout += b.toString(); });
          child.stderr.on('data', (b) => { stderr += b.toString(); });
          child.on('error', reject);
          child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Usage: npx codewikitap install');
        expect(result.stdout).toContain('--target');
      } finally {
        await fs.rm(linkDir, { recursive: true, force: true });
      }
    });
  });

  describe('TS-009: Pre-existing unrelated MCP entries survive', () => {
    it('mcpServers.other is byte-identical post-run; codewikitap added alongside', async () => {
      const target = path.join(tmpHome, '.claude/mcp.json');
      await fs.mkdir(path.dirname(target), { recursive: true });
      const original = {
        mcpServers: { 'other-server': { command: 'node', args: ['other.js'] } },
      };
      await fs.writeFile(target, JSON.stringify(original, null, 2));

      const result = await run(
        ['--target=claude-code', '--scope=user', '--yes'],
        env,
        tmpCwd,
      );
      expect(result.code).toBe(0);
      const final = JSON.parse(await fs.readFile(target, 'utf8'));
      expect(final.mcpServers['other-server']).toEqual({ command: 'node', args: ['other.js'] });
      expect(final.mcpServers.codewikitap).toEqual({
        command: 'npx',
        args: ['-y', 'codewikitap'],
      });
      const bak = JSON.parse(await fs.readFile(`${target}.bak`, 'utf8'));
      expect(bak).toEqual(original);
    });
  });
});
