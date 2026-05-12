// Source: https://antigravity.google/docs/mcp (verified 2026-05-12)
// Antigravity uses `mcpServers` in `~/.gemini/antigravity/mcp_config.json` — user scope only;
// no per-project config path is documented upstream.
import * as path from 'node:path';
import { type InstallerAdapter } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

export const antigravity: InstallerAdapter = {
  id: 'antigravity',
  displayName: 'Antigravity',
  supportedScopes: ['user'],
  pathFor(_scope, ctx) {
    return path.join(ctx.home, '.gemini', 'antigravity', 'mcp_config.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcpServers.codewikitap', entry);
  },
  serialize: serializeJson,
};
