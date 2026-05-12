import * as path from 'node:path';
import { type InstallerAdapter } from '../adapter.js';
import { readJsonFile, mergeIntoJson, serializeJson } from '../io.js';

export const geminiCli: InstallerAdapter = {
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  supportedScopes: ['project', 'user'],
  pathFor(scope, ctx) {
    return scope === 'project'
      ? path.join(ctx.cwd, '.gemini', 'settings.json')
      : path.join(ctx.home, '.gemini', 'settings.json');
  },
  read: readJsonFile,
  merge(parsed, entry) {
    return mergeIntoJson(parsed, 'mcpServers.codewikitap', entry);
  },
  serialize: serializeJson,
};
