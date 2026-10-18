import type { ServiceCtx } from '../domain/context.ts';

/**
 * Retention and housekeeping (runs with the cron trigger; few cheap statements).
 * Free text of finished trades is erased after DATA_RETENTION_DAYS; the financial skeleton
 * (ids, status, txids, audit actions) is kept for traceability.
 */
export async function runCleanup(ctx: ServiceCtx): Promise<void> {
  const now = ctx.now();
  const retentionCutoff = now - ctx.cfg.dataRetentionDays * 86400;
  const terminal = `SELECT id FROM trades WHERE status IN ('COMPLETE','REFUNDED','CANCELLED','FAILED') AND updated_at < ?`;
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE invites SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`).bind(now),
    ctx.db.prepare('DELETE FROM processed_telegram_updates WHERE processed_at < ?').bind(now - 7 * 86400),
    ctx.db.prepare('DELETE FROM conversation_state WHERE expires_at < ?').bind(now),
    ctx.db.prepare('DELETE FROM access_attempts WHERE created_at < ?').bind(now - 30 * 86400),
    ctx.db.prepare('DELETE FROM blockchain_observations WHERE created_at < ?').bind(now - 30 * 86400),
    ctx.db
      .prepare(`UPDATE trades SET description = '[gelöscht]', terms = '[gelöscht]' WHERE id IN (${terminal}) AND terms <> '[gelöscht]'`)
      .bind(retentionCutoff),
    ctx.db
      .prepare(
        `UPDATE disputes SET reason = '[gelöscht]', decision_note = NULL, evidence_links = NULL WHERE trade_id IN (${terminal}) AND reason <> '[gelöscht]'`,
      )
      .bind(retentionCutoff),
    ctx.db
      .prepare(
        `UPDATE dispute_events SET note = NULL WHERE note IS NOT NULL AND dispute_id IN (SELECT id FROM disputes WHERE trade_id IN (${terminal}))`,
      )
      .bind(retentionCutoff),
    ctx.db
      .prepare(`UPDATE trade_agreements SET content_json = '{}' WHERE trade_id IN (${terminal}) AND content_json <> '{}'`)
      .bind(retentionCutoff),
    ctx.db
      .prepare(`UPDATE psbt_sessions SET base_psbt = '', raw_tx_hex = NULL WHERE trade_id IN (${terminal}) AND base_psbt <> ''`)
      .bind(retentionCutoff),
  ]);
}
