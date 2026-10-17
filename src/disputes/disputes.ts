import { MAX_DISPUTE_REASON_CHARS } from '../config/constants.ts';
import { auditStmt, getOpenDispute, getTrade, listParticipants, transition, type DisputeRow } from '../database/repo.ts';
import type { Notice, ServiceCtx } from '../domain/context.ts';
import { UserError } from '../domain/context.ts';
import { askRecipientAddress } from '../domain/payout.ts';
import type { TradeState } from '../domain/state-machine.ts';
import { authorize, cleanText, groupNotice, isSigningRole, signerIds } from '../domain/trade.ts';

/** States from which a buyer/seller may open a dispute. */
const DISPUTABLE: ReadonlySet<TradeState> = new Set(['FUNDING_SEEN', 'FUNDED', 'FULFILLMENT', 'RELEASE_REQUESTED', 'REFUND_REQUESTED', 'SIGNING']);

export const DISPUTE_LIMITS_TEXT =
  'Wichtig: Der Bot kann BTC on-chain NICHT einfrieren. Käufer und Verkäufer könnten weiterhin gemeinsam ' +
  'außerhalb des Bots signieren. Der Streitfall stoppt nur die botseitigen Abläufe (keine Freigabe, kein Senden durch den Bot). ' +
  'Bereits abgegebene Signaturen bleiben auf Bitcoin-Ebene gültig.';

function validateLinks(raw: string | null): string | null {
  if (!raw) return null;
  const links = raw.split(/\s+/).filter(Boolean);
  if (links.length > 5) throw new UserError('Maximal 5 Links.');
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l);
    } catch {
      throw new UserError(`Ungültiger Link: ${l.slice(0, 40)}`);
    }
    if (u.protocol !== 'https:') throw new UserError('Nur https-Links erlaubt.');
  }
  return links.join(' ');
}

export async function openDispute(ctx: ServiceCtx, userId: number, tradeId: string, reasonRaw: string, linksRaw: string | null): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'open_dispute');
  if (!DISPUTABLE.has(a.trade.status)) throw new UserError('In diesem Status kann kein Streitfall eröffnet werden.');
  if (await getOpenDispute(ctx.db, tradeId)) throw new UserError('Es gibt bereits einen offenen Streitfall.');
  const reason = cleanText(reasonRaw, MAX_DISPUTE_REASON_CHARS, 'Begründung');
  const links = validateLinks(linksRaw);
  const now = ctx.now();
  try {
    await transition(ctx.db, {
      tradeId, from: a.trade.status, to: 'DISPUTED', expectedVersion: a.trade.version, actorId: userId, action: 'dispute_opened', now,
      followUps: (g, gp) => [
        ctx.db
          .prepare(`INSERT INTO disputes (trade_id, opened_by, reason, evidence_links, status, opened_at) SELECT ?, ?, ?, ?, 'open', ? WHERE ${g}`)
          .bind(tradeId, userId, reason, links, now, ...gp),
        // stop bot-side payout: lock any live signing session
        ctx.db
          .prepare(`UPDATE psbt_sessions SET status = 'locked', updated_at = ? WHERE trade_id = ? AND status IN ('open','finalized') AND ${g}`)
          .bind(now, tradeId, ...gp),
      ],
    });
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw new UserError('Es gibt bereits einen offenen Streitfall.');
    throw e;
  }
  const parts = await listParticipants(ctx.db, tradeId);
  const s = signerIds(parts);
  const notices: Notice[] = parts
    .filter((p) => p.telegram_user_id !== userId && (isSigningRole(p.role) || p.role === 'mediator'))
    .map((p) => ({
      chatId: p.telegram_user_id,
      text: `⚠️ Handel #${tradeId}: Streitfall eröffnet. Botseitige Freigaben sind gestoppt.\n\n${DISPUTE_LIMITS_TEXT}`,
      buttons: p.telegram_user_id === s.arbiter ? [[{ text: 'Fall übernehmen', data: `d:${tradeId}:take` }]] : [[{ text: 'Support', url: ctx.cfg.supportUrl }]],
    }));
  notices.push({
    chatId: userId,
    text: `Streitfall für #${tradeId} eröffnet. Der Schlichter wurde benachrichtigt.\n\n${DISPUTE_LIMITS_TEXT}`,
    buttons: [[{ text: 'Support kontaktieren', url: ctx.cfg.supportUrl }]],
  });
  return [...notices, ...groupNotice(a.trade, 'STREITFALL')];
}

export async function takeCase(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'decide_dispute');
  if (a.trade.status !== 'DISPUTED') throw new UserError('Kein offener Streitfall.');
  const d = (await getOpenDispute(ctx.db, tradeId))!;
  const now = ctx.now();
  await transition(ctx.db, {
    tradeId, from: 'DISPUTED', to: 'ARBITRATION', expectedVersion: a.trade.version, actorId: userId, action: 'arbitration_started', now,
    followUps: (g, gp) => [
      ctx.db.prepare(`UPDATE disputes SET status = 'arbitration' WHERE id = ? AND ${g}`).bind(d.id, ...gp),
      ctx.db.prepare(`INSERT INTO dispute_events (dispute_id, actor_id, kind, created_at) SELECT ?, ?, 'taken', ? WHERE ${g}`).bind(d.id, userId, now, ...gp),
    ],
  });
  const s = signerIds(await listParticipants(ctx.db, tradeId));
  return [
    {
      chatId: userId,
      text: disputeText(d) + '\n\nEntscheidung:',
      buttons: [
        [{ text: 'Release an Verkäufer', data: `d:${tradeId}:release` }],
        [{ text: 'Refund an Käufer', data: `d:${tradeId}:refund` }],
        [{ text: 'Rückfrage an Parteien', data: `d:${tradeId}:ask` }],
      ],
    },
    ...[s.buyer, s.seller].filter((x): x is number => x !== undefined).map((chatId) => ({
      chatId,
      text: `Handel #${tradeId}: Der Schlichter prüft den Streitfall.`,
    })),
  ];
}

export function disputeText(d: DisputeRow): string {
  return `Streitfall #${d.id} (Handel #${d.trade_id})\nStatus: ${d.status}\nBegründung:\n${d.reason}${d.evidence_links ? `\n\nLinks:\n${d.evidence_links}` : ''}`;
}

export async function addDisputeNote(ctx: ServiceCtx, userId: number, tradeId: string, noteRaw: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'view_dispute');
  if (!isSigningRole(a.role)) throw new UserError('Keine Berechtigung.');
  const d = await getOpenDispute(ctx.db, tradeId);
  if (!d) throw new UserError('Kein offener Streitfall.');
  const note = cleanText(noteRaw, MAX_DISPUTE_REASON_CHARS, 'Nachricht');
  await ctx.db
    .prepare('INSERT INTO dispute_events (dispute_id, actor_id, kind, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(d.id, userId, a.role === 'arbiter' ? 'question' : 'statement', note, ctx.now())
    .run();
  const s = signerIds(await listParticipants(ctx.db, tradeId));
  const label = a.role === 'arbiter' ? 'Rückfrage des Schlichters' : `Stellungnahme (${a.role === 'buyer' ? 'Käufer' : 'Verkäufer'})`;
  return [s.buyer, s.seller, s.arbiter]
    .filter((x): x is number => x !== undefined && x !== userId)
    .map((chatId) => ({
      chatId,
      text: `Handel #${tradeId} – ${label}:\n${note}`,
      buttons: [[{ text: 'Antworten', data: `d:${tradeId}:ask` }]],
    }));
}

export async function decideDispute(ctx: ServiceCtx, userId: number, tradeId: string, decision: 'release' | 'refund', noteRaw: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'decide_dispute');
  if (a.trade.status !== 'ARBITRATION') throw new UserError('Fall ist nicht in Schlichtung.');
  const d = await getOpenDispute(ctx.db, tradeId);
  if (!d) throw new UserError('Kein offener Streitfall.');
  const note = cleanText(noteRaw, MAX_DISPUTE_REASON_CHARS, 'Begründung');
  const now = ctx.now();
  const to = decision === 'release' ? 'RELEASE_REQUESTED' : 'REFUND_REQUESTED';
  await transition(ctx.db, {
    tradeId, from: 'ARBITRATION', to, expectedVersion: a.trade.version, actorId: userId, action: `dispute_decided_${decision}`, now, detail: note.slice(0, 200),
    followUps: (g, gp) => [
      ctx.db
        .prepare(`UPDATE disputes SET status = 'resolved', decision = ?, decision_note = ?, resolved_at = ?, resolved_by = ? WHERE id = ? AND ${g}`)
        .bind(decision, note, now, userId, d.id, ...gp),
      ctx.db.prepare(`INSERT INTO dispute_events (dispute_id, actor_id, kind, note, created_at) SELECT ?, ?, ?, ?, ? WHERE ${g}`).bind(d.id, userId, `decision_${decision}`, note, now, ...gp),
      // the locked pre-dispute session can never be used by the bot again
      ctx.db.prepare(`UPDATE psbt_sessions SET status = 'cancelled', updated_at = ? WHERE trade_id = ? AND status = 'locked' AND ${g}`).bind(now, tradeId, ...gp),
    ],
  });
  const trade = (await getTrade(ctx.db, tradeId))!;
  const s = signerIds(await listParticipants(ctx.db, tradeId));
  const info: Notice[] = [s.buyer, s.seller].filter((x): x is number => x !== undefined).map((chatId) => ({
    chatId,
    text: `Handel #${tradeId}: Schlichterentscheidung: ${decision === 'release' ? 'Auszahlung an Verkäufer' : 'Rückerstattung an Käufer'}.\nBegründung: ${note}\n\nDie Auszahlung erfordert die Signatur des Schlichters und des Empfängers.`,
  }));
  return [...info, ...(await askRecipientAddress(ctx, trade, decision))];
}

export async function listOpenDisputes(ctx: ServiceCtx, userId: number): Promise<DisputeRow[]> {
  const r = await ctx.db
    .prepare(
      `SELECT d.* FROM disputes d JOIN participants p ON p.trade_id = d.trade_id
       WHERE p.telegram_user_id = ? AND p.status = 'active' AND p.role IN ('buyer','seller','arbiter','mediator') AND d.status <> 'resolved'
       ORDER BY d.opened_at DESC LIMIT 20`,
    )
    .bind(userId)
    .all<DisputeRow>();
  return r.results;
}

export { auditStmt };
