/**
 * Runtime Node-version guard.
 *
 * Why this exists: `package.json:engines.node` is `>=22.5.0`, but npm emits
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

export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;

export interface NodeVersionDeps {
  readonly versions: NodeJS.ProcessVersions;
  readonly stderrWrite: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

function buildRecoveryMessage(current: string): string {
  const floor = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;
  return (
    `codewikitap requires Node.js >= ${floor} (current: ${current}).\n` +
    `Install a supported Node version from https://nodejs.org/ or via your\n` +
    `version manager (e.g. nvm install ${MIN_NODE_MAJOR}, ` +
    `fnm install ${MIN_NODE_MAJOR}, ` +
    `volta install node@${MIN_NODE_MAJOR}).\n`
  );
}

export function assertNodeVersion(deps: NodeVersionDeps): void {
  // Regex captures both major and minor; pre-release suffixes like
  // `22.5.0-rc.1` are tolerated because the digits we care about come first.
  // process.versions.node normally returns dotted-numeric (e.g. "22.5.1"),
  // but defensive parsing keeps the guard honest for embedded/forked builds.
  const match = /^(\d+)\.(\d+)/.exec(deps.versions.node);
  if (match) {
    const major = Number.parseInt(match[1]!, 10);
    const minor = Number.parseInt(match[2]!, 10);
    if (
      Number.isFinite(major) &&
      Number.isFinite(minor) &&
      (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR))
    ) {
      return;
    }
  }
  deps.stderrWrite(buildRecoveryMessage(deps.versions.node));
  deps.exit(1);
}
