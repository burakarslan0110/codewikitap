/**
 * Thin wrapper over better-sqlite3 with a Map-backed in-memory fallback.
 *
 * The native binding is loaded with a dynamic `await import('better-sqlite3')`
 * inside `openStore()` so the try/catch around the import can fall back to the
 * Map implementation when the native build fails (under `module: NodeNext`,
 * a top-level static `import` cannot be wrapped in try/catch).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SqliteStore {
  /** Run a parameterless statement (e.g., PRAGMA, CREATE TABLE). */
  exec(sql: string): void;
  /** Prepare a SELECT/INSERT/UPDATE/DELETE statement; returns a small handle. */
  prepare(sql: string): SqliteStatement;
  /** Close the underlying database. */
  close(): void;
  /** True when the implementation is the in-memory Map fallback. */
  readonly isInMemory: boolean;
  /**
   * v2.6: true when the sqlite-vec extension was loaded successfully on this
   * connection. False on the in-memory backend, OR when sqlite-vec failed to
   * load at runtime (post-install — e.g. macOS SIP denying extension load).
   * Consumers (Cache v6 migration, VectorStore native query path) gate on
   * this. False forces the pure-JS cosine fallback.
   */
  readonly vecAvailable: boolean;
}

export interface SqliteStatement {
  /** Run an INSERT/UPDATE/DELETE; returns rows affected. */
  run(...params: unknown[]): { changes: number };
  /** Run a SELECT and return a single row, or undefined. */
  get(...params: unknown[]): Record<string, unknown> | undefined;
  /** Run a SELECT and return all rows. */
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface OpenStoreOptions {
  dbPath: string;
  forceInMemory?: boolean;
}

export async function openStore(opts: OpenStoreOptions): Promise<SqliteStore> {
  if (opts.forceInMemory) {
    return new InMemoryStore();
  }

  let nativeBetterSqlite: { default: new (filename: string) => unknown } | null = null;
  try {
    // Dynamic import so a missing/broken native binding can't crash module load.
    nativeBetterSqlite = (await import('better-sqlite3')) as { default: new (filename: string) => unknown };
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'warn',
        msg: 'better-sqlite3 native binding unavailable; falling back to in-memory cache',
        reason: err instanceof Error ? err.message : String(err),
      }) + '\n',
    );
    return new InMemoryStore();
  }

  // Ensure the parent directory exists.
  fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });

  const Ctor = nativeBetterSqlite.default;
  // The native handle has the methods we wrap.
  // Loose typing on purpose — better-sqlite3 types are CJS-only and the dynamic
  // import shape varies across environments.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = new Ctor(opts.dbPath) as any;
  handle.pragma('journal_mode = WAL');

  // v2.6: try to load the sqlite-vec extension. Failure is non-fatal — the
  // pure-JS cosine path in vector_store.ts engages when vecAvailable is false.
  // Install-time failure of sqlite-vec blocks `pnpm install` (it's now a hard
  // dep); runtime load failure here covers the SIP-denied / sandboxed case.
  let vecAvailable = false;
  try {
    // Dynamic import so a missing module is non-fatal at runtime (would only
    // happen if a user removed sqlite-vec from node_modules manually).
    const sqliteVec = (await import('sqlite-vec')) as { load: (db: unknown) => void };
    sqliteVec.load(handle);
    vecAvailable = true;
    process.stderr.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'info',
        msg: 'sqlite_vec.loaded',
      }) + '\n',
    );
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'warn',
        msg: 'sqlite_vec.load_failed',
        reason: err instanceof Error ? err.message : String(err),
      }) + '\n',
    );
  }

  return {
    isInMemory: false,
    vecAvailable,
    exec(sql: string): void { handle.exec(sql); },
    prepare(sql: string): SqliteStatement {
      const stmt = handle.prepare(sql);
      return {
        run: (...p: unknown[]) => stmt.run(...p) as { changes: number },
        get: (...p: unknown[]) => stmt.get(...p) as Record<string, unknown> | undefined,
        all: (...p: unknown[]) => stmt.all(...p) as Array<Record<string, unknown>>,
      };
    },
    close(): void { handle.close(); },
  };
}

// ---------------------------------------------------------------------------
// In-memory fallback
// ---------------------------------------------------------------------------

interface InMemoryTable {
  rows: Map<string, Record<string, unknown>>;
  primaryKey: string[];
}

class InMemoryStore implements SqliteStore {
  readonly isInMemory = true;
  readonly vecAvailable = false;
  private readonly tables = new Map<string, InMemoryTable>();

  exec(sql: string): void {
    // Parse a tiny subset of CREATE TABLE statements — enough for our schema.
    // CREATE TABLE IF NOT EXISTS <name> (col TEXT, ..., PRIMARY KEY (a, b));
    const ddlMatch = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]*)\)\s*;?/i.exec(sql);
    if (!ddlMatch) return;
    const [, tableName, cols] = ddlMatch;
    if (this.tables.has(tableName)) return;
    let primaryKey: string[] = [];
    const pkMatch = /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(cols);
    if (pkMatch) {
      primaryKey = pkMatch[1].split(',').map((c) => c.trim());
    } else {
      // Look for inline PRIMARY KEY on a column.
      const inlinePk = /(\w+)\s+\w+\s+PRIMARY\s+KEY/i.exec(cols);
      if (inlinePk) primaryKey = [inlinePk[1]];
    }
    this.tables.set(tableName, { rows: new Map(), primaryKey });
  }

  prepare(sql: string): SqliteStatement {
    return new InMemoryStatement(this.tables, sql);
  }

  close(): void { this.tables.clear(); }
}

class InMemoryStatement implements SqliteStatement {
  constructor(private readonly tables: Map<string, InMemoryTable>, private readonly sql: string) {}

  run(...params: unknown[]): { changes: number } {
    const insertMatch = /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i.exec(this.sql);
    if (insertMatch) {
      const [, table, cols] = insertMatch;
      const t = this.tables.get(table);
      if (!t) throw new Error(`unknown table ${table}`);
      const colNames = cols.split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      colNames.forEach((c, i) => { row[c] = params[i]; });
      const key = t.primaryKey.map((k) => String(row[k])).join('|');
      t.rows.set(key, row);
      return { changes: 1 };
    }
    const updateMatch = /UPDATE\s+(\w+)\s+SET\s+([^\s].+?)\s+WHERE\s+(.+)/is.exec(this.sql);
    if (updateMatch) {
      const [, table, setClause, whereClause] = updateMatch;
      const t = this.tables.get(table);
      if (!t) throw new Error(`unknown table ${table}`);
      const setAssignments = setClause.split(',').map((c) => c.trim().replace(/\s*=\s*\?$/, ''));
      const whereCols = whereClause.split(/\s+AND\s+/i).map((c) => c.trim().replace(/\s*=\s*\?$/, ''));
      let changes = 0;
      for (const [k, row] of t.rows) {
        const matchesWhere = whereCols.every((col, i) => row[col] === params[setAssignments.length + i]);
        if (matchesWhere) {
          setAssignments.forEach((col, i) => { row[col] = params[i]; });
          t.rows.set(k, row);
          changes++;
        }
      }
      return { changes };
    }
    const deleteMatch = /DELETE\s+FROM\s+(\w+)\s+WHERE\s+(.+)/i.exec(this.sql);
    if (deleteMatch) {
      const [, table, whereClause] = deleteMatch;
      const t = this.tables.get(table);
      if (!t) throw new Error(`unknown table ${table}`);
      const whereCols = whereClause.split(/\s+AND\s+/i).map((c) => c.trim().replace(/\s*=\s*\?$/, ''));
      let changes = 0;
      const toDelete: string[] = [];
      for (const [k, row] of t.rows) {
        const matchesWhere = whereCols.every((col, i) => row[col] === params[i]);
        if (matchesWhere) { toDelete.push(k); changes++; }
      }
      toDelete.forEach((k) => t.rows.delete(k));
      return { changes };
    }
    return { changes: 0 };
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const rows = this.all(...params);
    return rows[0];
  }

  all(...params: unknown[]): Array<Record<string, unknown>> {
    const selectMatch = /SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/is.exec(this.sql);
    if (!selectMatch) return [];
    const [, , table, whereClause] = selectMatch;
    const t = this.tables.get(table);
    if (!t) return [];
    const out: Array<Record<string, unknown>> = [];
    const whereCols = whereClause
      ? whereClause.split(/\s+AND\s+/i).map((c) => c.trim().replace(/\s*=\s*\?$/, ''))
      : [];
    for (const row of t.rows.values()) {
      const matches = whereCols.length === 0
        ? true
        : whereCols.every((col, i) => row[col] === params[i]);
      if (matches) out.push({ ...row });
    }
    return out;
  }
}
