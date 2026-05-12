import { InstallerError, type Scope } from './adapter.js';

export type ParsedArgs =
  | { kind: 'help' }
  | { kind: 'error'; code: number; message: string }
  | {
      kind: 'run';
      target: string | undefined;
      scope: Scope | undefined;
      yes: boolean;
      dryRun: boolean;
    };

const KNOWN_FLAGS = new Set([
  '--help',
  '-h',
  '--yes',
  '--dry-run',
  '--target',
  '--scope',
]);

function isScope(v: string): v is Scope {
  return v === 'project' || v === 'user';
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let target: string | undefined;
  let scope: Scope | undefined;
  let yes = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--help' || tok === '-h') return { kind: 'help' };
    if (tok === '--yes') { yes = true; continue; }
    if (tok === '--dry-run') { dryRun = true; continue; }

    const eq = tok.indexOf('=');
    const [flag, inlineVal] = eq >= 0 ? [tok.slice(0, eq), tok.slice(eq + 1)] : [tok, undefined];

    if (!KNOWN_FLAGS.has(flag)) {
      return { kind: 'error', code: 2, message: `unknown flag: ${tok}` };
    }

    const value = inlineVal ?? argv[++i];
    if (value === undefined) {
      return { kind: 'error', code: 2, message: `${flag} requires a value` };
    }

    if (flag === '--target') target = value;
    else if (flag === '--scope') {
      if (!isScope(value)) {
        return { kind: 'error', code: 2, message: `--scope must be project|user, got: ${value}` };
      }
      scope = value;
    }
  }
  return { kind: 'run', target, scope, yes, dryRun };
}

export function assertStdioGuard(argv: readonly string[]): void {
  // Defense-in-depth: this function MUST be unreachable unless the bin entry
  // dispatched to the installer. The argv guard in src/index.ts is the first
  // layer; this is the second. If a future refactor accidentally imports
  // wizard.ts or cli.ts from server.ts, this throws before any stdout write.
  if (argv[2] !== 'install') {
    throw new InstallerError(
      'stdio_guard_violation',
      `installer entered with argv[2]=${argv[2] ?? '<undefined>'}; expected 'install'`,
    );
  }
}

const USAGE = `Usage: npx codewikitap install [options]

Options:
  --target=<id>     Target tool. One of: claude-code, cursor, codex-cli,
                    gemini-cli, qwen-code, opencode, windsurf, antigravity
  --scope=<scope>   Where to install: project | user
  --yes             Skip interactive confirmation (auto-overwrite on conflict)
  --dry-run         Print the resolved plan; do not write anything
  --help, -h        Show this help text

When stdin is not a TTY (CI, piped invocation), --target and --scope are
required. In interactive mode, all flags are optional and the wizard prompts
for what's missing.

Examples:
  npx codewikitap install
  npx codewikitap install --target=claude-code --scope=user --yes
  npx codewikitap install --target=cursor --scope=project --dry-run
`;

export function printHelp(): void {
  process.stdout.write(USAGE);
}

export async function runInstallerCli(argv: readonly string[]): Promise<void> {
  assertStdioGuard(process.argv);

  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    printHelp();
    return;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(`error: ${parsed.message}\n\n${USAGE}`);
    process.exit(parsed.code);
  }

  const { runWizard } = await import('./wizard.js');
  try {
    await runWizard({
      target: parsed.target,
      scope: parsed.scope,
      yes: parsed.yes,
      dryRun: parsed.dryRun,
    });
  } catch (err) {
    if (err instanceof InstallerError && err.kind === 'missing_required_flag') {
      process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw err;
  }
}
