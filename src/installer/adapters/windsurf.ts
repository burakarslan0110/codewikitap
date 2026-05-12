// Source: https://docs.windsurf.com/windsurf/cascade/mcp (verified 2026-05-12)
// Windsurf uses `mcpServers` in `~/.codeium/windsurf/mcp_config.json` — user scope only;
// no per-project config path is documented upstream.
import * as path from 'node:path';
import { type InstallerAdapter } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

export const windsurf: InstallerAdapter = {
  id: 'windsurf',
  displayName: 'Windsurf',
  supportedScopes: ['user'],
  pathFor(_scope, ctx) {
    return path.join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcpServers.codewikitap', entry);
  },
  serialize: serializeJson,
};
