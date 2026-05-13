// Cross-platform: path documented identical on Linux/macOS/Windows
// (relies on os.homedir() resolution; no XDG/APPDATA branching).
import * as path from 'node:path';
import { type InstallerAdapter } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

export const cursor: InstallerAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  supportedScopes: ['project', 'user'],
  pathFor(scope, ctx) {
    return scope === 'project'
      ? path.join(ctx.cwd, '.cursor', 'mcp.json')
      : path.join(ctx.home, '.cursor', 'mcp.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcpServers.codewikitap', entry);
  },
  serialize: serializeJson,
};
