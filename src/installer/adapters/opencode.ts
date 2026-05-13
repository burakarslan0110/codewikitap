// Source: https://opencode.ai/docs/config/ (verified 2026-05-12)
// opencode uses `mcp.<name>` (object map, NOT `mcpServers`) and requires a
// `type: "local"` discriminator on each entry (vs `type: "remote"` for HTTP).
// Cross-platform: user-scope path is XDG_CONFIG_HOME-aware on Linux/macOS and
// APPDATA-aware on Windows. Empty-string env vars fall through to the home
// default — some Linux desktops export XDG_CONFIG_HOME='' which would
// otherwise resolve to '/opencode/opencode.json' (filesystem root).
import * as path from 'node:path';
import { type InstallerAdapter, type McpEntry } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

function toOpencodeEntry(entry: McpEntry): Record<string, unknown> {
  return { type: 'local', command: entry.command, args: [...entry.args] };
}

export const opencode: InstallerAdapter = {
  id: 'opencode',
  displayName: 'opencode',
  supportedScopes: ['project', 'user'],
  pathFor(scope, ctx) {
    if (scope === 'project') return path.join(ctx.cwd, 'opencode.json');
    const platform = ctx.platform ?? process.platform;
    const env = ctx.env ?? process.env;
    if (platform === 'win32') {
      const appData = env.APPDATA && env.APPDATA.length > 0
        ? env.APPDATA
        : path.join(ctx.home, 'AppData', 'Roaming');
      return path.join(appData, 'opencode', 'opencode.json');
    }
    const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : path.join(ctx.home, '.config');
    return path.join(xdg, 'opencode', 'opencode.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcp.codewikitap', toOpencodeEntry(entry));
  },
  serialize: serializeJson,
};
