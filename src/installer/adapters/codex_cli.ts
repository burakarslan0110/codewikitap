// Source: README.md "Installation per agent" — Codex CLI uses TOML config at
// ~/.codex/config.toml with [mcp_servers.codewikitap] table. User scope only.
// Cross-platform: path documented identical on Linux/macOS/Windows.
import * as path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from '@iarna/toml';
import { type InstallerAdapter, type AdapterReadResult, type McpEntry } from '../adapter.js';
import { promises as fs } from 'node:fs';

export const codexCli: InstallerAdapter = {
  id: 'codex-cli',
  displayName: 'Codex CLI',
  supportedScopes: ['user'],
  // NOTE: Codex CLI stores its entries under `mcp_servers.codewikitap` in TOML,
  // but the wizard's diff lookup has always used `mcpServers.codewikitap` (the
  // JSON-default). This preserves that pre-existing behavior — the diff prompt
  // for codex-cli never fires on a re-write. Fixing this is a separate bugfix.
  keyPath: 'mcpServers.codewikitap',
  pathFor(_scope, ctx) {
    return path.join(ctx.home, '.codex', 'config.toml');
  },
  async read(filePath): Promise<AdapterReadResult> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
      throw err;
    }
    try {
      return { status: 'parsed', value: parseToml(raw) };
    } catch (err) {
      return {
        status: 'parse_error',
        raw,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  },
  merge(parsed: AdapterReadResult, entry: McpEntry): unknown {
    const into: Record<string, unknown> =
      parsed.status === 'parsed' && parsed.value && typeof parsed.value === 'object'
        ? { ...(parsed.value as Record<string, unknown>) }
        : {};
    const existing = into['mcp_servers'];
    const servers: Record<string, unknown> =
      existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown>) } : {};
    servers['codewikitap'] = { command: entry.command, args: [...entry.args] };
    into['mcp_servers'] = servers;
    return into;
  },
  serialize(merged: unknown): string {
    return stringifyToml(merged as Parameters<typeof stringifyToml>[0]);
  },
};
