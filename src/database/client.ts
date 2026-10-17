/**
 * Minimal D1 surface used by the app. Production passes env.DB (D1Database);
 * tests pass a node:sqlite-backed implementation with the same semantics.
 */
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number; last_row_id?: number } }>;
}

export interface Db {
  prepare(sql: string): DbStatement;
  /** Executes statements atomically (single transaction). */
  batch(statements: DbStatement[]): Promise<{ meta: { changes: number } }[]>;
}

export class DbError extends Error {
  override name = 'DbError';
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);

/** Runs a conditional UPDATE and returns true if a row changed (optimistic lock helper). */
export async function changed(stmt: DbStatement): Promise<boolean> {
  const r = await stmt.run();
  return r.meta.changes > 0;
}
