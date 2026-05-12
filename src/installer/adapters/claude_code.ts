import * as path from 'node:path';
import { type InstallerAdapter } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

export const claudeCode: InstallerAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  supportedScopes: ['project', 'user'],
  pathFor(scope, ctx) {
    return scope === 'project' ? path.join(ctx.cwd, '.mcp.json') : path.join(ctx.home, '.claude', 'mcp.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcpServers.codewikitap', entry);
  },
  serialize: serializeJson,
};
