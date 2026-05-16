// Source: https://code.visualstudio.com/docs/copilot/reference/mcp-configuration (verified 2026-05-13)
// VS Code MCP config lives in `.vscode/mcp.json` (project) or the VS Code user
// data dir (user). Top-level key is `servers` (NOT `mcpServers`); stdio entries
// take the explicit `type: "stdio"` discriminator the docs list as required.
//
// Cross-platform: user-scope path branches on platform (unlike the 7 home-anchored
// adapters). The macOS branch deliberately ignores `XDG_CONFIG_HOME` — see the
// inline comment below.
import * as path from 'node:path';
import { type InstallerAdapter, type McpEntry } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

function toVscodeEntry(entry: McpEntry): Record<string, unknown> {
  return { type: 'stdio', command: entry.command, args: [...entry.args] };
}

export const vscode: InstallerAdapter = {
  id: 'vscode',
  displayName: 'Visual Studio Code',
  supportedScopes: ['project', 'user'],
  keyPath: 'servers.codewikitap',
  pathFor(scope, ctx) {
    if (scope === 'project') return path.join(ctx.cwd, '.vscode', 'mcp.json');
    const platform = ctx.platform ?? process.platform;
    const env = ctx.env ?? process.env;
    if (platform === 'win32') {
      const appData =
        env.APPDATA && env.APPDATA.length > 0
          ? env.APPDATA
          : path.join(ctx.home, 'AppData', 'Roaming');
      return path.join(appData, 'Code', 'User', 'mcp.json');
    }
    if (platform === 'darwin') {
      // macOS: VS Code is an Electron app and uses app.getPath('userData') which
      // resolves to ~/Library/Application Support/Code — it does NOT read
      // XDG_CONFIG_HOME on macOS (unlike opencode, which honors XDG on all
      // Unix-like platforms). Locked by the darwin XDG-ignored test in
      // tests/unit/installer.test.ts.
      return path.join(ctx.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
    }
    const xdg =
      env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
        ? env.XDG_CONFIG_HOME
        : path.join(ctx.home, '.config');
    return path.join(xdg, 'Code', 'User', 'mcp.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'servers.codewikitap', toVscodeEntry(entry));
  },
  serialize: serializeJson,
};
