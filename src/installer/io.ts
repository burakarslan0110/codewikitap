import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';

import { InstallerError, type AdapterReadResult, type McpEntry } from './adapter.js';

export async function atomicWrite(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content);
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function backupIfExists(target: string): Promise<string | null> {
  let exists = true;
  try {
    await fs.access(target);
  } catch {
    exists = false;
  }
  if (!exists) return null;

  const primary = `${target}.bak`;
  let primaryExists = true;
  try {
    await fs.access(primary);
  } catch {
    primaryExists = false;
  }
  // Replace `:` and `.` with `-` so the suffix is a legal filename on Windows.
  const dest = primaryExists ? `${target}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}` : primary;
  await fs.copyFile(target, dest);
  return dest;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMergeJson(into: unknown, dottedKey: string, value: unknown): unknown {
  const segments = dottedKey.split('.');
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new InstallerError('invalid_argument', `invalid key path: ${dottedKey}`);
  }
  const root: Record<string, unknown> = isPlainObject(into) ? { ...into } : {};
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const next = cursor[key];
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else if (isPlainObject(next)) {
      const copy = { ...next };
      cursor[key] = copy;
      cursor = copy;
    } else {
      throw new InstallerError(
        'merge_path_conflict',
        `cannot traverse '${dottedKey}': '${key}' is ${typeof next}, not an object`,
      );
    }
  }
  cursor[segments[segments.length - 1]!] = value;
  return root;
}

export function tildeExpand(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export async function readJsonFile(filePath: string): Promise<AdapterReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    throw err;
  }
  try {
    return { status: 'parsed', value: JSON.parse(raw) };
  } catch (err) {
    return {
      status: 'parse_error',
      raw,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export function mergeIntoJson(
  parsed: AdapterReadResult,
  keyPath: string,
  entry: McpEntry | Record<string, unknown>,
): unknown {
  const into =
    parsed.status === 'parsed' && parsed.value && typeof parsed.value === 'object'
      ? parsed.value
      : {};
  return deepMergeJson(into, keyPath, entry);
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
