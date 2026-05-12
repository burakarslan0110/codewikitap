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
}

export interface InstallerAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportedScopes: readonly Scope[];
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
  | 'merge_path_conflict';

export class InstallerError extends Error {
  readonly kind: InstallerErrorKind;
  constructor(kind: InstallerErrorKind, message?: string) {
    super(message ?? kind);
    this.kind = kind;
    this.name = 'InstallerError';
  }
}
