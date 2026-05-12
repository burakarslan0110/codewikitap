import * as os from 'node:os';
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdout as defaultStdout, stdin as defaultStdin } from 'node:process';

import {
  InstallerError,
  type Scope,
  type InstallerAdapter,
  type McpEntry,
} from './adapter.js';
import { assertStdioGuard } from './cli.js';
import { ADAPTERS, findAdapter } from './adapters/index.js';
import { atomicWrite, backupIfExists } from './io.js';

export interface WizardOpts {
  readonly target: string | undefined;
  readonly scope: Scope | undefined;
  readonly yes: boolean;
  readonly dryRun: boolean;
}

export interface Prompter {
  ask(prompt: string): Promise<string>;
  close(): void;
}

export interface WizardDeps {
  readonly home: string;
  readonly cwd: string;
  readonly stderr: (chunk: string) => void;
  readonly stdout: (chunk: string) => void;
  readonly createReadlineFn: () => Prompter;
  readonly argv: readonly string[];
}

const CANONICAL_ENTRY: McpEntry = { command: 'npx', args: ['-y', 'codewikitap'] };

// Lightweight line-based prompter — reads all of stdin upfront when stdin
// is piped, falls back to readline for true TTY. Avoids the Node readline
// "unhandled error" on EOF that breaks tests piping input via spawn.
function createDefaultPrompter(): Prompter {
  if (process.stdin.isTTY === true) {
    const rl = readline.createInterface({ input: defaultStdin, output: defaultStdout });
    return {
      ask: (prompt) => rl.question(prompt),
      close: () => rl.close(),
    };
  }
  // Piped / file-redirected stdin: read everything up front, then dispense
  // line by line. Avoids readline's promise rejection on EOF.
  let buffered = '';
  try {
    buffered = fs.readFileSync(0, 'utf8');
  } catch {
    buffered = '';
  }
  const lines = buffered.split('\n');
  let idx = 0;
  return {
    async ask(prompt) {
      defaultStdout.write(prompt);
      if (idx >= lines.length) {
        throw new InstallerError(
          'missing_required_flag',
          'stdin closed before all required answers were read',
        );
      }
      return lines[idx++]!;
    },
    close() { /* nothing to release */ },
  };
}

function defaultDeps(): WizardDeps {
  return {
    home: os.homedir(),
    cwd: process.cwd(),
    stderr: (s) => { process.stderr.write(s); },
    stdout: (s) => { process.stdout.write(s); },
    createReadlineFn: createDefaultPrompter,
    argv: process.argv,
  };
}

function extractCurrentEntry(parsedValue: unknown, dottedKey: string): unknown {
  const segments = dottedKey.split('.');
  let cursor: unknown = parsedValue;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in (cursor as Record<string, unknown>)) {
      cursor = (cursor as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cursor;
}

export function formatDiff(current: unknown, proposed: unknown): string {
  const lines: string[] = [];
  lines.push('Current:');
  lines.push(JSON.stringify(current, null, 2));
  lines.push('');
  lines.push('Proposed:');
  lines.push(JSON.stringify(proposed, null, 2));
  return lines.join('\n');
}

function keyPathFor(adapter: InstallerAdapter): string {
  // opencode is the only registered adapter that uses `mcp.<name>` instead
  // of `mcpServers.<name>`. Everything else (including the Codex TOML, which
  // has its own merge path) uses `mcpServers.codewikitap`.
  return adapter.id === 'opencode' ? 'mcp.codewikitap' : 'mcpServers.codewikitap';
}

function stdinHasInputSource(): boolean {
  // TTY → interactive terminal. FIFO → shell pipe. Socket → child_process.spawn
  // with stdio:'pipe'. File → redirected from a regular file (`< input.txt`).
  // The refuse case is a character device with no real input — most importantly
  // /dev/null when the child is started with stdio:'ignore' — which would let
  // readline silently EOF without giving the user a chance to type anything.
  if (process.stdin.isTTY === true) return true;
  try {
    const s = fs.fstatSync(0);
    return s.isFIFO() || s.isSocket() || s.isFile();
  } catch {
    return false;
  }
}

async function askLine(rl: Prompter, prompt: string, what: string): Promise<string> {
  if (!stdinHasInputSource()) {
    throw new InstallerError(
      'missing_required_flag',
      `--${what} is required when running without an interactive terminal`,
    );
  }
  const answer = await rl.ask(prompt);
  return answer.trim();
}

async function pickFromMenu<T>(
  rl: Prompter,
  prompt: string,
  options: readonly T[],
  label: (opt: T) => string,
  what: string,
): Promise<T> {
  const lines = options.map((opt, i) => `  [${i + 1}] ${label(opt)}`).join('\n');
  const answer = await askLine(rl, `${prompt}\n${lines}\n> `, what);
  const idx = Number.parseInt(answer, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > options.length) {
    throw new InstallerError('invalid_argument', `expected number 1..${options.length}, got: ${answer}`);
  }
  return options[idx - 1]!;
}

export async function runWizard(opts: WizardOpts, depsIn?: WizardDeps): Promise<void> {
  const deps = depsIn ?? defaultDeps();
  assertStdioGuard(deps.argv);

  // Resolve adapter — flag value or interactive pick.
  let adapter: InstallerAdapter | undefined;
  if (opts.target !== undefined) {
    adapter = findAdapter(opts.target);
    if (!adapter) {
      throw new InstallerError('unknown_target', `unknown --target: ${opts.target}`);
    }
  }

  // Resolve scope — flag value or interactive pick (after adapter chosen).
  let scope: Scope | undefined = opts.scope;
  if (scope !== undefined && adapter && !adapter.supportedScopes.includes(scope)) {
    throw new InstallerError(
      'unsupported_scope',
      `${adapter.id} does not support scope=${scope}; supported: ${adapter.supportedScopes.join(', ')}`,
    );
  }

  // Lazy readline: only open if we have something to ask.
  let rl: Prompter | undefined;
  const ensureRl = (): Prompter => {
    if (!rl) rl = deps.createReadlineFn();
    return rl;
  };

  try {
    if (!adapter) {
      adapter = await pickFromMenu(ensureRl(), 'Select target:', ADAPTERS, (a) => a.displayName, 'target');
    }
    if (!scope) {
      if (adapter.supportedScopes.length === 1) {
        scope = adapter.supportedScopes[0]!;
      } else {
        scope = await pickFromMenu(
          ensureRl(),
          'Select scope:',
          adapter.supportedScopes,
          (s) => (s === 'project' ? 'Project (current directory)' : 'User (home directory)'),
          'scope',
        );
      }
    }

    const resolvedPath = adapter.pathFor(scope, { home: deps.home, cwd: deps.cwd });
    const current = await adapter.read(resolvedPath);
    const merged = adapter.merge(current, CANONICAL_ENTRY);
    const nextContent = adapter.serialize(merged);

    // Dry-run short-circuits BEFORE backupIfExists — preserves lazy-backup invariant.
    if (opts.dryRun) {
      deps.stdout(`Would write: ${resolvedPath}\n\n`);
      deps.stdout(nextContent);
      return;
    }

    // Determine overwrite/skip when the codewikitap key already exists with
    // a different shape than the canonical entry.
    let action: 'overwrite' | 'skip' = 'overwrite';
    if (current.status === 'parsed') {
      const keyPath = keyPathFor(adapter);
      const existing = extractCurrentEntry(current.value, keyPath);
      const proposed = extractCurrentEntry(merged, keyPath);
      const differs = existing !== undefined && JSON.stringify(existing) !== JSON.stringify(proposed);
      if (differs && !opts.yes) {
        deps.stdout(`${formatDiff(existing, proposed)}\n\n`);
        const ans = (await askLine(
          ensureRl(),
          'Existing codewikitap entry differs. [o]verwrite / [s]kip / [c]ancel? ',
          'confirm',
        )).toLowerCase();
        if (ans === 's' || ans === 'skip') action = 'skip';
        else if (ans === 'c' || ans === 'cancel') {
          deps.stderr('[codewikitap] cancelled by user\n');
          return;
        }
      }
    } else if (current.status === 'parse_error' && !opts.yes) {
      deps.stdout(`Existing config at ${resolvedPath} could not be parsed: ${current.reason}\n`);
      const ans = (await askLine(
        ensureRl(),
        'Overwrite with a fresh file (existing content backed up to .bak)? [y/N] ',
        'confirm',
      )).toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        deps.stderr('[codewikitap] cancelled (parse error)\n');
        return;
      }
    }

    if (action === 'skip') {
      deps.stderr(`[codewikitap] skipped ${resolvedPath}\n`);
      return;
    }

    // Lazy backup — ONLY on the overwrite branch, NEVER on dry-run / skip / cancel.
    await backupIfExists(resolvedPath);
    await atomicWrite(resolvedPath, nextContent);
    deps.stderr(`[codewikitap] wrote ${resolvedPath}\n`);
  } finally {
    if (rl) rl.close();
  }
}
