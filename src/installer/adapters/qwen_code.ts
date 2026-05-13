// Source: https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/ (verified 2026-05-12)
// Qwen Code uses `mcpServers` in `.qwen/settings.json` (project) or `~/.qwen/settings.json` (user).
// Cross-platform: path documented identical on Linux/macOS/Windows.
import * as path from 'node:path';
import { type InstallerAdapter } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

export const qwenCode: InstallerAdapter = {
  id: 'qwen-code',
  displayName: 'Qwen Code',
  supportedScopes: ['project', 'user'],
  pathFor(scope, ctx) {
    return scope === 'project'
      ? path.join(ctx.cwd, '.qwen', 'settings.json')
      : path.join(ctx.home, '.qwen', 'settings.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcpServers.codewikitap', entry);
  },
  serialize: serializeJson,
};
