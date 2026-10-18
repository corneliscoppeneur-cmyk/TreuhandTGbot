import { auditStmt, getLiveSession, getOpenDispute, getTrade, listFunding, transition, type TradeRow } from '../database/repo.ts';
import { PermissionError } from './permissions.ts';
import type { Notice, ServiceCtx } from './context.ts';
import { UserError } from './context.ts';
import { decisionButtons } from '../disputes/disputes.ts';
import { operatorMode } from './operator.ts';

/**
 * Operator/admin tools: overview of trades that need attention, resolving NEEDS_REVIEW
 * and unblocking users. Admin actions never move BTC by themselves: resuming only returns
 * a trade to FUNDED, arbitration still needs two wallet signatures.
 */

export function requireAdmin(ctx: ServiceCtx, userId: number): void {
  if (!ctx.cfg.adminIds.has(userId)) throw new PermissionError('Nur für Admins.');
}

const ATTENTION = ['NEEDS_REVIEW', 'DISPUTED', 'ARBITRATION'] as const;

export async function attentionList(ctx: ServiceCtx, userId: number): Promise<TradeRow[]> {
  requireAdmin(ctx, userId);
  const r = await ctx.db
    .prepare(`SELECT * FROM trades WHERE status IN (${ATTENTION.map(() => '?').join(',')}) ORDER BY updated_at LIMIT 30`)
    .bind(...ATTENTION)
    .all<TradeRow>();
  return r.results;
}

export async function statsLine(ctx: ServiceCtx): Promise<string> {
  const r = await ctx.db
    .prepare(
      `SELECT
         SUM(CASE WHEN status NOT IN ('COMPLETE','REFUNDED','CANCELLED','FAILED') THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status IN ('COMPLETE','REFUNDED') THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status IN ('COMPLETE','REFUNDED') THEN fee_sats ELSE 0 END) AS fees
       FROM trades`,
    )
    .first<{ open: number | null; done: number | null; fees: number | null }>();
  const blocked = await ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_blocked = 1').first<{ n: number }>();
  return `Offene Handel: ${r?.open ?? 0} · Abgeschlossen: ${r?.done ?? 0} · Gebühren verdient: ${r?.fees ?? 0} sat · Gesperrte Nutzer: ${blocked?.n ?? 0}`;
}

async function needsReview(ctx: ServiceCtx, userId: number, tradeId: string): Promise<TradeRow> {
  requireAdmin(ctx, userId);
  const t = await getTrade(ctx.db, tradeId);
  if (!t) throw new UserError('Handel nicht gefunden.');
  if (t.status !== 'NEEDS_REVIEW') throw new UserError('Der Handel ist nicht in Prüfung.');
  return t;
}

/** NEEDS_REVIEW → FUNDED, only if the full deposit is still confirmed in the escrow and nothing is being paid out. */
export async function resumeTrade(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  const t = await needsReview(ctx, userId, tradeId);
  const confirmed = (await listFunding(ctx.db, tradeId))
    .filter((f) => f.status === 'confirmed')
    .reduce((s, f) => s + BigInt(f.value_sats), 0n);
  if (confirmed < BigInt(t.amount_sats) + BigInt(t.fee_sats)) {
    throw new UserError('Fortsetzen nicht möglich: Im Treuhand-Konto liegt nicht (mehr) der volle bestätigte Betrag.');
  }
  if (await getLiveSession(ctx.db, tradeId)) throw new UserError('Es gibt noch eine laufende Auszahlung.');
  const now = ctx.now();
  await transition(ctx.db, {
    tradeId,
    from: 'NEEDS_REVIEW',
    to: 'FUNDED',
    expectedVersion: t.version,
    actorId: userId,
    action: 'admin_resumed',
    now,
    set: { sql: 'review_reason = NULL', params: [] },
    followUps: (g, gp) => [
      ctx.db
        .prepare(`INSERT OR REPLACE INTO scheduled_jobs (trade_id, next_poll_at, failures) SELECT ?, ?, 0 WHERE ${g}`)
        .bind(tradeId, now, ...gp),
    ],
  });
  return [{ chatId: userId, text: `✅ Handel #${tradeId} läuft wieder (Status FINANZIERT).` }];
}

/** NEEDS_REVIEW → ARBITRATION with a dispute record, so the arbiter decides release or refund. */
export async function arbitrateTrade(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  const t = await needsReview(ctx, userId, tradeId);
  if (!operatorMode(ctx) || userId !== ctx.cfg.operatorId) throw new UserError('Entscheiden kann nur der Schlichter des Handels.');
  if (await getOpenDispute(ctx.db, tradeId)) throw new UserError('Es gibt bereits einen offenen Streitfall.');
  const now = ctx.now();
  await transition(ctx.db, {
    tradeId,
    from: 'NEEDS_REVIEW',
    to: 'ARBITRATION',
    expectedVersion: t.version,
    actorId: userId,
    action: 'admin_arbitration',
    now,
    followUps: (g, gp) => [
      ctx.db
        .prepare(`INSERT INTO disputes (trade_id, opened_by, reason, status, opened_at) SELECT ?, ?, ?, 'arbitration', ? WHERE ${g}`)
        .bind(tradeId, userId, `Admin-Prüfung: ${t.review_reason ?? 'ohne Grund'}`, now, ...gp),
    ],
  });
  return [{ chatId: userId, text: `⚖️ Handel #${tradeId}: Bitte entscheiden.`, buttons: decisionButtons(tradeId) }];
}

/** NEEDS_REVIEW → FAILED (e.g. funds already gone). Final. */
export async function failTrade(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  const t = await needsReview(ctx, userId, tradeId);
  await transition(ctx.db, {
    tradeId,
    from: 'NEEDS_REVIEW',
    to: 'FAILED',
    expectedVersion: t.version,
    actorId: userId,
    action: 'admin_failed',
    now: ctx.now(),
    followUps: (g, gp) => [ctx.db.prepare(`DELETE FROM scheduled_jobs WHERE trade_id = ? AND ${g}`).bind(tradeId, ...gp)],
  });
  return [{ chatId: userId, text: `Handel #${tradeId} als fehlgeschlagen geschlossen.` }];
}

export async function blockedUsers(ctx: ServiceCtx, userId: number): Promise<{ telegram_user_id: number; username: string | null }[]> {
  requireAdmin(ctx, userId);
  const r = await ctx.db
    .prepare('SELECT telegram_user_id, username FROM users WHERE is_blocked = 1 ORDER BY last_seen_at DESC LIMIT 30')
    .all<{ telegram_user_id: number; username: string | null }>();
  return r.results;
}

export async function unblockUser(ctx: ServiceCtx, userId: number, target: number): Promise<Notice[]> {
  requireAdmin(ctx, userId);
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db.prepare('UPDATE users SET is_blocked = 0 WHERE telegram_user_id = ?').bind(target),
    auditStmt(ctx.db, { tradeId: null, actorId: userId, action: 'admin_unblocked', detail: String(target), now }),
  ]);
  return [{ chatId: userId, text: `✅ Nutzer ${target} entsperrt.` }];
}
