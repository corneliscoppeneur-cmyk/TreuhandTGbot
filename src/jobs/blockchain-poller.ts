import { confirmations, evaluateFunding } from '../bitcoin/funding.ts';
import { ProviderError, type ChainUtxo } from '../blockchain/provider.ts';
import {
  auditStmt,
  getLiveSession,
  getMultisig,
  getTrade,
  listFunding,
  listParticipants,
  setSettingStmt,
  transition,
  type FundingRow,
  type TradeRow,
} from '../database/repo.ts';
import { formatBtc } from '../domain/amount.ts';
import type { Notice, ServiceCtx } from '../domain/context.ts';
import { STATE_LABEL_DE, type TradeState } from '../domain/state-machine.ts';
import { groupNotice, isSigningRole, signerIds } from '../domain/trade.ts';
import { logError, redact } from '../security/redaction.ts';

const FUNDING_STATES: ReadonlySet<TradeState> = new Set(['READY_TO_FUND', 'FUNDING_SEEN']);
const HOLDING_STATES: ReadonlySet<TradeState> = new Set([
  'FUNDED', 'FULFILLMENT', 'RELEASE_REQUESTED', 'REFUND_REQUESTED', 'SIGNING', 'DISPUTED', 'ARBITRATION',
]);

const MIN = 60;
const INTERVAL = { funding: 5 * MIN, fundingIdle: 60 * MIN, holding: 30 * MIN, broadcast: 3 * MIN };

export interface PollResult {
  polled: number;
  errors: number;
  notices: Notice[];
}

/**
 * Central scheduled poller: one cron trigger, a bounded batch of due trades per run.
 * Never derives a final state from a single failed/ambiguous API answer; on disagreement the
 * trade goes to NEEDS_REVIEW, on transient errors it backs off and retries later.
 */
export async function runPoller(ctx: ServiceCtx): Promise<PollResult> {
  const now = ctx.now();
  const due = (
    await ctx.db
      .prepare('SELECT trade_id, failures FROM scheduled_jobs WHERE next_poll_at <= ? ORDER BY next_poll_at LIMIT ?')
      .bind(now, ctx.cfg.pollMaxTradesPerRun)
      .all<{ trade_id: string; failures: number }>()
  ).results;

  const result: PollResult = { polled: 0, errors: 0, notices: [] };
  if (due.length === 0) return result;
  let tip: number;
  try {
    tip = await ctx.chain.getTipHeight();
  } catch (e) {
    logError('poller', e);
    await recordHealth(ctx, 'poller_last_error', redact(e));
    return { ...result, errors: 1 };
  }

  for (const job of due) {
    result.polled++;
    try {
      const next = await pollTrade(ctx, job.trade_id, tip, result.notices);
      if (next === null) {
        await ctx.db.prepare('DELETE FROM scheduled_jobs WHERE trade_id = ?').bind(job.trade_id).run();
      } else {
        await ctx.db
          .prepare('UPDATE scheduled_jobs SET next_poll_at = ?, failures = 0, last_error = NULL, last_polled_at = ? WHERE trade_id = ?')
          .bind(ctx.now() + next, ctx.now(), job.trade_id)
          .run();
      }
    } catch (e) {
      result.errors++;
      logError(`poller:${job.trade_id}`, e);
      if (e instanceof ProviderError && e.kind === 'disagreement') {
        result.notices.push(...(await toReview(ctx, job.trade_id, 'Blockchain-APIs liefern widersprüchliche Daten')));
      }
      const backoff = Math.min(INTERVAL.funding * 2 ** Math.min(job.failures, 6), 6 * 3600);
      await ctx.db
        .prepare('UPDATE scheduled_jobs SET next_poll_at = ?, failures = failures + 1, last_error = ?, last_polled_at = ? WHERE trade_id = ?')
        .bind(ctx.now() + backoff, redact(e).slice(0, 200), ctx.now(), job.trade_id)
        .run();
    }
  }
  await recordHealth(ctx, 'poller_last_run', String(now));
  return result;
}

async function recordHealth(ctx: ServiceCtx, key: string, value: string): Promise<void> {
  try {
    await setSettingStmt(ctx.db, key, value, ctx.now()).run();
  } catch (e) {
    logError('health', e);
  }
}

async function toReview(ctx: ServiceCtx, tradeId: string, reason: string): Promise<Notice[]> {
  const t = await getTrade(ctx.db, tradeId);
  if (!t || t.status === 'NEEDS_REVIEW' || t.status === 'COMPLETE' || t.status === 'REFUNDED') return [];
  try {
    await transition(ctx.db, {
      tradeId, from: t.status, to: 'NEEDS_REVIEW', expectedVersion: t.version, actorId: 0, action: 'needs_review', detail: reason, now: ctx.now(),
      set: { sql: 'review_reason = ?', params: [reason] },
    });
  } catch (e) {
    logError('toReview', e);
    return [];
  }
  return notifySigners(ctx, t, `⚠️ Handel #${tradeId}: Manuelle Prüfung erforderlich: ${reason}. Keine automatische Freigabe.`);
}

async function notifySigners(ctx: ServiceCtx, t: TradeRow, text: string): Promise<Notice[]> {
  const parts = await listParticipants(ctx.db, t.id);
  return parts.filter((p) => isSigningRole(p.role)).map((p) => ({ chatId: p.telegram_user_id, text }));
}

/** Returns seconds until next poll, or null to stop polling this trade. */
async function pollTrade(ctx: ServiceCtx, tradeId: string, tip: number, out: Notice[]): Promise<number | null> {
  const t = await getTrade(ctx.db, tradeId);
  if (!t) return null;
  if (FUNDING_STATES.has(t.status)) return pollFunding(ctx, t, tip, out);
  if (HOLDING_STATES.has(t.status)) return pollHolding(ctx, t, out);
  if (t.status === 'BROADCAST') return pollBroadcast(ctx, t, tip, out);
  return null;
}

async function upsertUtxos(ctx: ServiceCtx, t: TradeRow, utxos: ChainUtxo[], known: FundingRow[]): Promise<{ reorged: boolean }> {
  const now = ctx.now();
  let reorged = false;
  const stmts = utxos.map((u) => {
    const prev = known.find((k) => k.txid === u.txid && k.vout === u.vout);
    if (prev?.status === 'confirmed' && (!u.confirmed || prev.block_hash !== u.blockHash)) reorged = true;
    return ctx.db
      .prepare(
        `INSERT INTO funding_outputs (trade_id, txid, vout, value_sats, status, block_height, block_hash, first_seen_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(txid, vout) DO UPDATE SET status = excluded.status, block_height = excluded.block_height,
           block_hash = excluded.block_hash, updated_at = excluded.updated_at
         WHERE funding_outputs.trade_id = excluded.trade_id`,
      )
      .bind(t.id, u.txid, u.vout, Number(u.valueSats), u.confirmed ? 'confirmed' : 'unconfirmed', u.blockHeight, u.blockHash, now, now);
  });
  if (reorged) stmts.push(auditStmt(ctx.db, { tradeId: t.id, actorId: 0, action: 'reorg_detected', now }));
  if (stmts.length) await ctx.db.batch(stmts);
  return { reorged };
}

async function pollFunding(ctx: ServiceCtx, t: TradeRow, tip: number, out: Notice[]): Promise<number> {
  const ms = await getMultisig(ctx.db, t.id);
  if (!ms) return INTERVAL.fundingIdle;
  const utxos = await ctx.chain.getAddressUtxos(ms.address);
  const known = await listFunding(ctx.db, t.id);
  const { reorged } = await upsertUtxos(ctx, t, utxos, known);

  // Outputs we saw earlier that are no longer unspent on the address
  const current = new Set(utxos.map((u) => `${u.txid}:${u.vout}`));
  const missing = known.filter((k) => (k.status === 'unconfirmed' || k.status === 'confirmed') && !current.has(`${k.txid}:${k.vout}`));
  for (const k of missing) {
    const os = await ctx.chain.getOutspend(k.txid, k.vout);
    const status = os.spent ? 'spent' : 'vanished';
    await ctx.db
      .prepare('UPDATE funding_outputs SET status = ?, spent_txid = ?, updated_at = ? WHERE id = ?')
      .bind(status, os.spendingTxid, ctx.now(), k.id)
      .run();
    if (os.spent) {
      out.push(...(await toReview(ctx, t.id, 'Einzahlung wurde vor Abschluss der Finanzierung ausgegeben')));
      return INTERVAL.holding;
    }
  }

  const ev = evaluateFunding(BigInt(t.amount_sats), utxos, tip, ctx.cfg.minConfirmations);
  const now = ctx.now();
  const s = signerIds(await listParticipants(ctx.db, t.id));

  if (ev.verdict === 'overpaid') {
    out.push(...(await toReview(ctx, t.id, `Überzahlung: ${formatBtc(ev.totalSats)} statt ${formatBtc(BigInt(t.amount_sats))} BTC`)));
    return INTERVAL.holding;
  }
  if (ev.verdict === 'funded') {
    await transition(ctx.db, { tradeId: t.id, from: t.status, to: 'FUNDED', expectedVersion: t.version, actorId: 0, action: 'funded', now });
    const fresh = (await getTrade(ctx.db, t.id))!;
    out.push(
      ...(await notifySigners(ctx, fresh, `Handel #${t.id}: Einzahlung bestätigt (${ev.minConfirmations} Bestätigungen). Status: FINANZIERT.`)),
      ...(s.seller ? [{ chatId: s.seller, text: `Handel #${t.id}: Du kannst jetzt liefern und anschließend „Lieferung erfolgt“ melden.`, buttons: [[{ text: 'Lieferung erfolgt', data: `t:${t.id}:delivered` }]] }] : []),
      ...groupNotice(fresh, STATE_LABEL_DE.FUNDED),
    );
    return INTERVAL.holding;
  }
  if ((ev.verdict === 'pending' || ev.verdict === 'partial') && t.status === 'READY_TO_FUND') {
    await transition(ctx.db, { tradeId: t.id, from: 'READY_TO_FUND', to: 'FUNDING_SEEN', expectedVersion: t.version, actorId: 0, action: 'funding_seen', now });
    if (s.buyer) {
      out.push({
        chatId: s.buyer,
        text:
          ev.verdict === 'partial'
            ? `Handel #${t.id}: Teilzahlung erkannt (${formatBtc(ev.totalSats)} von ${formatBtc(BigInt(t.amount_sats))} BTC). Bitte Restbetrag senden.`
            : `Handel #${t.id}: Einzahlung gesehen, wartet auf ${ctx.cfg.minConfirmations} Bestätigung(en).`,
      });
    }
    return INTERVAL.funding;
  }
  if (ev.verdict === 'none' && t.status === 'FUNDING_SEEN') {
    // previously seen funding disappeared (dropped from mempool or reorged out)
    await transition(ctx.db, { tradeId: t.id, from: 'FUNDING_SEEN', to: 'READY_TO_FUND', expectedVersion: t.version, actorId: 0, action: 'funding_vanished', now });
    if (s.buyer) out.push({ chatId: s.buyer, text: `Handel #${t.id}: Die gesehene Einzahlung ist nicht mehr sichtbar (verworfen/Reorg). Bitte prüfen.` });
    return INTERVAL.funding;
  }
  if (reorged) out.push(...(await notifySigners(ctx, t, `Handel #${t.id}: Blockchain-Reorganisation erkannt. Bestätigungen werden neu gezählt.`)));
  const age = now - (t.params_locked_at ?? now);
  return ev.verdict === 'none' && age > 7 * 24 * 3600 ? INTERVAL.fundingIdle : INTERVAL.funding;
}

/** Funds should stay put while the trade is open. Any spend not made by our broadcast is flagged. */
async function pollHolding(ctx: ServiceCtx, t: TradeRow, out: Notice[]): Promise<number> {
  const ms = await getMultisig(ctx.db, t.id);
  if (!ms) return INTERVAL.holding;
  const utxos = await ctx.chain.getAddressUtxos(ms.address);
  const known = (await listFunding(ctx.db, t.id)).filter((k) => k.status === 'confirmed');
  const current = new Map(utxos.map((u) => [`${u.txid}:${u.vout}`, u]));
  for (const k of known) {
    const u = current.get(`${k.txid}:${k.vout}`);
    if (u && u.confirmed && u.blockHash === k.block_hash) continue;
    if (u && (!u.confirmed || u.blockHash !== k.block_hash)) {
      out.push(...(await toReview(ctx, t.id, 'Reorganisation betrifft die bestätigte Einzahlung')));
      return INTERVAL.holding;
    }
    const os = await ctx.chain.getOutspend(k.txid, k.vout);
    if (!os.spent) continue; // provider lag: UTXO list and outspend disagree; check again next run
    const session = await getLiveSession(ctx.db, t.id);
    const now = ctx.now();
    if (t.status === 'SIGNING' && session && session.status !== 'locked' && os.spendingTxid === session.txid) {
      // our exact, validated transaction was sent by a signer's wallet: follow it like our own broadcast
      await transition(ctx.db, {
        tradeId: t.id, from: 'SIGNING', to: 'BROADCAST', expectedVersion: t.version, actorId: 0, action: 'broadcast_external', detail: session.txid, now,
        followUps: (g, gp) => [ctx.db.prepare(`UPDATE psbt_sessions SET status = 'broadcast', broadcast_at = ?, updated_at = ? WHERE id = ? AND ${g}`).bind(now, now, session.id, ...gp)],
      });
      return INTERVAL.broadcast;
    }
    await ctx.db.prepare(`UPDATE funding_outputs SET status = 'spent', spent_txid = ?, updated_at = ? WHERE id = ?`).bind(os.spendingTxid, now, k.id).run();
    out.push(...(await toReview(ctx, t.id, 'Treuhand-UTXO wurde außerhalb des Bots ausgegeben (z. B. gemeinsame Signatur ohne Bot)')));
    return INTERVAL.holding;
  }
  if (utxos.length > known.length) {
    await upsertUtxos(ctx, t, utxos.filter((u) => !known.some((k) => k.txid === u.txid && k.vout === u.vout)), []);
    out.push(...(await notifySigners(ctx, t, `Handel #${t.id}: Zusätzliche Zahlung auf die Treuhandadresse erkannt. Diese wird NICHT automatisch verarbeitet.`)));
  }
  return INTERVAL.holding;
}

async function pollBroadcast(ctx: ServiceCtx, t: TradeRow, tip: number, out: Notice[]): Promise<number | null> {
  const session = await getLiveSession(ctx.db, t.id);
  if (!session || session.status !== 'broadcast') {
    out.push(...(await toReview(ctx, t.id, 'Gesendete Session nicht gefunden')));
    return null;
  }
  const st = await ctx.chain.getTxStatus(session.txid);
  const now = ctx.now();
  if (!st) {
    // not known: rebroadcast (same raw tx, harmless); escalate after 24h
    if (session.raw_tx_hex) await ctx.chain.broadcast(session.raw_tx_hex).catch((e) => logError('rebroadcast', e));
    if (now - (session.broadcast_at ?? now) > 24 * 3600) {
      out.push(...(await toReview(ctx, t.id, 'Transaktion nach 24 h nicht im Netzwerk sichtbar')));
      return null;
    }
    return INTERVAL.broadcast;
  }
  if (!st.confirmed || confirmations(tip, st.blockHeight) < ctx.cfg.minConfirmations) return INTERVAL.broadcast;
  const to = session.kind === 'release' ? 'COMPLETE' : 'REFUNDED';
  await transition(ctx.db, {
    tradeId: t.id, from: 'BROADCAST', to, expectedVersion: t.version, actorId: 0, action: 'payout_confirmed', detail: session.txid, now,
    followUps: (g, gp) => [
      ctx.db.prepare(`UPDATE psbt_sessions SET status = 'confirmed', updated_at = ? WHERE id = ? AND ${g}`).bind(now, session.id, ...gp),
      ctx.db.prepare(`UPDATE funding_outputs SET status = 'spent', spent_txid = ?, updated_at = ? WHERE trade_id = ? AND status = 'confirmed' AND ${g}`).bind(session.txid, now, t.id, ...gp),
    ],
  });
  const fresh = (await getTrade(ctx.db, t.id))!;
  out.push(
    ...(await notifySigners(ctx, fresh, `Handel #${t.id}: ${to === 'COMPLETE' ? 'Auszahlung' : 'Rückerstattung'} bestätigt. Handel ${STATE_LABEL_DE[to]}.`)),
    ...groupNotice(fresh, STATE_LABEL_DE[to]),
  );
  return null;
}
