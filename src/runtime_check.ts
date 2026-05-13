/**
 * Runtime Node-version guard.
 *
 * Why this exists: `package.json:engines.node` is `>=20.0.0`, but npm emits
 * only a warn-level `EBADENGINE` notice when a user installs on a lower
 * version — the install still completes. The runtime guard catches that
 * gap by hard-exiting with a clear recovery message before any other work
 * happens in the bin entry.
 *
 * Pure helper — all I/O routed through injected deps so the unit test can
 * assert without killing the test process. Called once at bin-entry from
 * `src/index.ts`; not called at module load (the guard would otherwise
 * trip unit tests that import named exports on legacy CI runners).
 */

export const MIN_NODE_MAJOR = 20;

export interface NodeVersionDeps {
  readonly versions: NodeJS.ProcessVersions;
  readonly stderrWrite: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

function buildRecoveryMessage(current: string): string {
  return (
    `codewikitap requires Node.js >= ${MIN_NODE_MAJOR} (current: ${current}).\n` +
    `Install a supported Node version from https://nodejs.org/ or via your\n` +
    `version manager (e.g. nvm install ${MIN_NODE_MAJOR}, fnm install ${MIN_NODE_MAJOR}).\n`
  );
}

export function assertNodeVersion(deps: NodeVersionDeps): void {
  const match = /^(\d+)/.exec(deps.versions.node);
  const major = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return;
  }
  deps.stderrWrite(buildRecoveryMessage(deps.versions.node));
  deps.exit(1);
}
