// Frozen adapter registry. Each adapter's path + key shape is documented in
// its own source file; see docs/plans/2026-05-12-interactive-mcp-installer.md
// "Target adapter matrix" for the verification sources.
import { type InstallerAdapter } from '../adapter.js';

import { claudeCode } from './claude_code.js';
import { cursor } from './cursor.js';
import { codexCli } from './codex_cli.js';
import { geminiCli } from './gemini_cli.js';
import { qwenCode } from './qwen_code.js';
import { opencode } from './opencode.js';
import { windsurf } from './windsurf.js';
import { antigravity } from './antigravity.js';

export const ADAPTERS: readonly InstallerAdapter[] = Object.freeze([
  claudeCode,
  cursor,
  codexCli,
  geminiCli,
  qwenCode,
  opencode,
  windsurf,
  antigravity,
]);

export function findAdapter(id: string): InstallerAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
