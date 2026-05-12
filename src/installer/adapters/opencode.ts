// Source: https://opencode.ai/docs/config/ (verified 2026-05-12)
// opencode uses `mcp.<name>` (object map, NOT `mcpServers`) and requires a
// `type: "local"` discriminator on each entry (vs `type: "remote"` for HTTP).
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
    return scope === 'project'
      ? path.join(ctx.cwd, 'opencode.json')
      : path.join(ctx.home, '.config', 'opencode', 'opencode.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcp.codewikitap', toOpencodeEntry(entry));
  },
  serialize: serializeJson,
};
