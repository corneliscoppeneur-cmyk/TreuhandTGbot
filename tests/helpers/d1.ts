/** TEST-ONLY D1 stand-in on node:sqlite (same SQLite dialect as D1). Applies all migrations. */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, DbStatement } from '../../src/database/client.ts';

type Value = null | number | bigint | string | Uint8Array;

class Stmt implements DbStatement {
  private db: TestDb;
  readonly sql: string;
  readonly params: Value[];
  constructor(db: TestDb, sql: string, params: Value[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values: unknown[]): DbStatement {
    return new Stmt(
      this.db,
      this.sql,
      values.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Value))),
    );
  }
  async first<T>(): Promise<T | null> {
    this.db.check();
    return (this.db.raw.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    this.db.check();
    return { results: this.db.raw.prepare(this.sql).all(...this.params) as T[] };
  }
  async run() {
    this.db.check();
    const r = this.db.raw.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync() {
    const r = this.db.raw.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(r.changes) } };
  }
}

export class TestDb implements Db {
  raw: DatabaseSync;
  /** Set to simulate a D1 outage. */
  failing = false;
  queries = 0;
  /** In-memory by default; a file path keeps state between runs (live Signet test). */
  constructor(path = ':memory:') {
    this.raw = new DatabaseSync(path);
    const exists = this.raw.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trades'`).get();
    if (exists) return;
    const dir = join(import.meta.dirname, '../../migrations');
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith('.sql'))
      .sort()) {
      this.raw.exec(readFileSync(join(dir, f), 'utf8'));
    }
  }
  check() {
    this.queries++;
    if (this.failing) throw new Error('D1_ERROR: simulated outage');
  }
  prepare(sql: string): DbStatement {
    return new Stmt(this, sql);
  }
  async batch(statements: DbStatement[]) {
    this.check();
    this.raw.exec('BEGIN');
    try {
      const out = statements.map((s) => (s as Stmt).runSync());
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }
}
