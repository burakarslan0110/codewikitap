export type Scope = 'project' | 'user';

export interface McpEntry {
  readonly command: string;
  readonly args: readonly string[];
}

export type AdapterReadResult =
  | { status: 'missing' }
  | { status: 'parsed'; value: unknown }
  | { status: 'parse_error'; raw: string; reason: string };

export interface AdapterContext {
  readonly home: string;
  readonly cwd: string;
  // Optional — populated by wizard.defaultDeps() from process.platform /
  // process.env. Adapters that don't branch on platform (the 7 home-anchored
  // adapters) ignore these; opencode reads them to honour XDG_CONFIG_HOME on
  // Unix and APPDATA on Windows.
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface InstallerAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportedScopes: readonly Scope[];
  // Dotted key path used by the wizard's diff/skip logic to locate this
  // adapter's entry inside the parsed config tree. JSON adapters use
  // `mcpServers.codewikitap` by default; `opencode` uses `mcp.codewikitap`
  // and `vscode` uses `servers.codewikitap`. The codex-cli TOML adapter
  // sets this to `mcpServers.codewikitap` to preserve the pre-existing
  // diff-lookup behavior (it serializes under `mcp_servers`, but the diff
  // never matched on it — fixing that is a separate bugfix).
  readonly keyPath: string;
  pathFor(scope: Scope, ctx: AdapterContext): string;
  read(filePath: string): Promise<AdapterReadResult>;
  merge(parsed: AdapterReadResult, entry: McpEntry): unknown;
  serialize(merged: unknown): string;
}

export type InstallerErrorKind =
  | 'stdio_guard_violation'
  | 'home_not_writable'
  | 'unknown_target'
  | 'unsupported_scope'
  | 'missing_required_flag'
  | 'parse_error'
  | 'invalid_argument'
  | 'merge_path_conflict'
  /** Parent-directory creation failed (mkdir EACCES/ENOSPC/etc). */
  | 'path_create_failed';

export class InstallerError extends Error {
  readonly kind: InstallerErrorKind;
  constructor(kind: InstallerErrorKind, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.name = 'InstallerError';
  }
}
