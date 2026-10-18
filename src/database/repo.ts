import { newSessionId } from '../security/tokens.ts';
import type { Role } from '../domain/permissions.ts';
import { assertTransition, type TradeState } from '../domain/state-machine.ts';
import type { Db, DbStatement } from './client.ts';

export interface TradeRow {
  id: string;
  creator_id: number;
  title: string;
  description: string;
  terms: string;
  amount_sats: number;
  network: string;
  commission_bps: number;
  refund_commission_bps: number;
  contract_version: number;
  agreement_hash: string | null;
  status: TradeState;
  version: number;
  params_locked_at: number | null;
  group_chat_id: number | null;
  review_reason: string | null;
  created_at: number;
  updated_at: number;
}

export interface ParticipantRow {
  id: number;
  trade_id: string;
  telegram_user_id: number;
  role: Role;
  status: 'active' | 'removed';
  agreed_hash: string | null;
  agreed_at: number | null;
  address_verified_at: number | null;
  joined_at: number;
}

export interface InviteRow {
  id: number;
  trade_id: string;
  role: Role;
  token_hash: string;
  code_hash: string | null;
  bound_user_id: number | null;
  max_uses: number;
  uses: number;
  attempts: number;
  status: 'active' | 'used' | 'revoked' | 'expired';
  expires_at: number;
  created_by: number;
  created_at: number;
}

export interface MultisigRow {
  trade_id: string;
  address: string;
  script_pubkey_hex: string;
  witness_script_hex: string;
  descriptor: string;
  signers_json: string;
  network: string;
}

export interface FundingRow {
  id: number;
  trade_id: string;
  txid: string;
  vout: number;
  value_sats: number;
  status: 'unconfirmed' | 'confirmed' | 'spent' | 'vanished';
  block_height: number | null;
  block_hash: string | null;
  spent_txid: string | null;
}

export interface SessionRow {
  id: string;
  trade_id: string;
  kind: 'release' | 'refund';
  status: 'open' | 'locked' | 'finalized' | 'broadcast' | 'confirmed' | 'cancelled' | 'failed';
  base_psbt: string;
  unsigned_tx_hex: string;
  txid: string;
  utxos_json: string;
  outputs_json: string;
  miner_fee_sats: number;
  fee_rate: number;
  raw_tx_hex: string | null;
  created_by: number;
  created_at: number;
  expires_at: number;
  broadcast_at: number | null;
}

export interface DisputeRow {
  id: number;
  trade_id: string;
  opened_by: number;
  reason: string;
  evidence_links: string | null;
  status: 'open' | 'arbitration' | 'resolved';
  decision: 'release' | 'refund' | null;
  decision_note: string | null;
  opened_at: number;
}

// ---------- users ----------

export function upsertUserStmt(db: Db, id: number, username: string | null, now: number): DbStatement {
  return db
    .prepare(
      `INSERT INTO users (telegram_user_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET username = excluded.username, last_seen_at = excluded.last_seen_at, bot_unreachable = 0`,
    )
    .bind(id, username, now, now);
}

export async function isUserBlocked(db: Db, id: number): Promise<boolean> {
  const r = await db.prepare('SELECT is_blocked FROM users WHERE telegram_user_id = ?').bind(id).first<{ is_blocked: number }>();
  return r?.is_blocked === 1;
}

// ---------- trades ----------

export function getTrade(db: Db, id: string): Promise<TradeRow | null> {
  return db.prepare('SELECT * FROM trades WHERE id = ?').bind(id).first<TradeRow>();
}

export async function listUserTrades(db: Db, userId: number): Promise<(TradeRow & { role: Role })[]> {
  const r = await db
    .prepare(
      `SELECT t.*, p.role FROM trades t JOIN participants p ON p.trade_id = t.id
       WHERE p.telegram_user_id = ? AND p.status = 'active' ORDER BY t.updated_at DESC LIMIT 20`,
    )
    .bind(userId)
    .all<TradeRow & { role: Role }>();
  return r.results;
}

export function getParticipant(db: Db, tradeId: string, userId: number): Promise<ParticipantRow | null> {
  return db
    .prepare(`SELECT * FROM participants WHERE trade_id = ? AND telegram_user_id = ? AND status = 'active'`)
    .bind(tradeId, userId)
    .first<ParticipantRow>();
}

export async function listParticipants(db: Db, tradeId: string): Promise<ParticipantRow[]> {
  const r = await db
    .prepare(`SELECT * FROM participants WHERE trade_id = ? AND status = 'active' ORDER BY id`)
    .bind(tradeId)
    .all<ParticipantRow>();
  return r.results;
}

export function auditStmt(
  db: Db,
  e: {
    tradeId: string | null;
    actorId: number;
    action: string;
    from?: string | null;
    to?: string | null;
    detail?: string | null;
    now: number;
  },
): DbStatement {
  return db
    .prepare(
      'INSERT INTO audit_events (trade_id, actor_id, action, from_status, to_status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(e.tradeId, e.actorId, e.action, e.from ?? null, e.to ?? null, e.detail ?? null, e.now);
}

export interface TransitionInput {
  tradeId: string;
  from: TradeState;
  to: TradeState;
  expectedVersion: number;
  actorId: number;
  action: string;
  detail?: string;
  now: number;
  /** Extra column assignments for the trade row (trusted constant SQL only). */
  set?: { sql: string; params: unknown[] };
  /**
   * Builds follow-up statements that must only run if the transition wins.
   * Each must include the guard `EXISTS (SELECT 1 FROM trades WHERE id = ? AND last_op = ?)`
   * using the supplied guard SQL and params.
   */
  followUps?: (guardSql: string, guardParams: unknown[]) => DbStatement[];
}

export class ConcurrencyError extends Error {
  override name = 'ConcurrencyError';
  constructor() {
    super('Der Handel wurde zwischenzeitlich geändert. Bitte erneut versuchen.');
  }
}

/**
 * Atomic, idempotent state transition with optimistic locking.
 * Runs as one D1 batch (one transaction); follow-ups and the audit event are guarded by a
 * random op id so that a losing concurrent request changes nothing.
 */
export async function transition(db: Db, t: TransitionInput): Promise<void> {
  assertTransition(t.from, t.to);
  const op = newSessionId();
  const guardSql = 'EXISTS (SELECT 1 FROM trades WHERE id = ? AND last_op = ?)';
  const guardParams = [t.tradeId, op];
  const extra = t.set ? `, ${t.set.sql}` : '';
  const update = db
    .prepare(
      `UPDATE trades SET status = ?, version = version + 1, last_op = ?, updated_at = ?${extra}
       WHERE id = ? AND status = ? AND version = ?`,
    )
    .bind(t.to, op, t.now, ...(t.set?.params ?? []), t.tradeId, t.from, t.expectedVersion);
  const audit = db
    .prepare(
      `INSERT INTO audit_events (trade_id, actor_id, action, from_status, to_status, detail, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guardSql}`,
    )
    .bind(t.tradeId, t.actorId, t.action, t.from, t.to, t.detail ?? null, t.now, ...guardParams);
  const res = await db.batch([update, audit, ...(t.followUps?.(guardSql, guardParams) ?? [])]);
  if ((res[0]?.meta.changes ?? 0) !== 1) throw new ConcurrencyError();
}

// ---------- multisig / funding / sessions / disputes ----------

export function getMultisig(db: Db, tradeId: string): Promise<MultisigRow | null> {
  return db.prepare('SELECT * FROM multisig_configs WHERE trade_id = ?').bind(tradeId).first<MultisigRow>();
}

export async function listFunding(db: Db, tradeId: string): Promise<FundingRow[]> {
  const r = await db.prepare('SELECT * FROM funding_outputs WHERE trade_id = ? ORDER BY id').bind(tradeId).all<FundingRow>();
  return r.results;
}

export function getLiveSession(db: Db, tradeId: string): Promise<SessionRow | null> {
  return db
    .prepare(`SELECT * FROM psbt_sessions WHERE trade_id = ? AND status IN ('open','locked','finalized','broadcast')`)
    .bind(tradeId)
    .first<SessionRow>();
}

export function getSession(db: Db, id: string): Promise<SessionRow | null> {
  return db.prepare('SELECT * FROM psbt_sessions WHERE id = ?').bind(id).first<SessionRow>();
}

export function getOpenDispute(db: Db, tradeId: string): Promise<DisputeRow | null> {
  return db.prepare(`SELECT * FROM disputes WHERE trade_id = ? AND status <> 'resolved'`).bind(tradeId).first<DisputeRow>();
}

// ---------- settings / counters ----------

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export function setSettingStmt(db: Db, key: string, value: string, now: number): DbStatement {
  return db
    .prepare(
      `INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now);
}
