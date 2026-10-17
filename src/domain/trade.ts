import { CONTRACT_VERSION, MAX_DESCRIPTION_CHARS, MAX_TERMS_CHARS, MAX_TITLE_CHARS } from '../config/constants.ts';
import {
  auditStmt,
  getParticipant,
  getTrade,
  listParticipants,
  transition,
  type ParticipantRow,
  type TradeRow,
} from '../database/repo.ts';
import { sha256Hex, newTradeId } from '../security/tokens.ts';
import { looksLikeMnemonic, looksLikePrivateKey } from '../security/redaction.ts';
import type { Notice, ServiceCtx } from './context.ts';
import { UserError } from './context.ts';
import { PermissionError, requirePermission, SIGNING_ROLES, type Action, type Role } from './permissions.ts';
import { FUNDS_AT_RISK_STATES, type TradeState } from './state-machine.ts';

export interface NewTradeInput {
  title: string;
  description: string;
  terms: string;
  amountSats: bigint;
  creatorRole: 'buyer' | 'seller';
}

export function cleanText(text: string, max: number, field: string): string {
  const t = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (t.length === 0) throw new UserError(`${field} darf nicht leer sein`);
  if (t.length > max) throw new UserError(`${field} ist zu lang (max. ${max} Zeichen)`);
  if (looksLikeMnemonic(t) || looksLikePrivateKey(t)) {
    throw new UserError('Das sieht nach einer Seed-Phrase oder einem privaten Schlüssel aus. Niemals teilen! Bitte anderen Text eingeben.');
  }
  return t;
}

export async function createTrade(ctx: ServiceCtx, userId: number, input: NewTradeInput): Promise<TradeRow> {
  const title = cleanText(input.title, MAX_TITLE_CHARS, 'Titel');
  const description = cleanText(input.description, MAX_DESCRIPTION_CHARS, 'Beschreibung');
  const terms = cleanText(input.terms, MAX_TERMS_CHARS, 'Bedingungen');
  const now = ctx.now();
  const id = newTradeId();
  await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT INTO trades (id, creator_id, title, description, terms, amount_sats, network, commission_bps,
           refund_commission_bps, contract_version, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INVITING', ?, ?)`,
      )
      .bind(id, userId, title, description, terms, Number(input.amountSats), ctx.cfg.network, ctx.cfg.commissionBps,
        ctx.cfg.refundCommissionBps, CONTRACT_VERSION, now, now),
    ctx.db
      .prepare('INSERT INTO participants (trade_id, telegram_user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .bind(id, userId, input.creatorRole, now),
    auditStmt(ctx.db, { tradeId: id, actorId: userId, action: 'trade_created', to: 'INVITING', now }),
  ]);
  const t = await getTrade(ctx.db, id);
  if (!t) throw new Error('trade insert failed');
  return t;
}

export interface Access {
  trade: TradeRow;
  participant: ParticipantRow | null;
  role: Role | null;
  isAdmin: boolean;
}

/** Loads a trade and authorizes the action for the user. Unknown trade and missing access look the same. */
export async function authorize(ctx: ServiceCtx, userId: number, tradeId: string, action: Action): Promise<Access> {
  if (!/^[A-Z0-9]{8}$/.test(tradeId)) throw new PermissionError('Handel nicht gefunden');
  const trade = await getTrade(ctx.db, tradeId);
  const isAdmin = ctx.cfg.adminIds.has(userId);
  if (!trade) throw new PermissionError('Handel nicht gefunden');
  const participant = await getParticipant(ctx.db, tradeId, userId);
  if (!participant && !isAdmin) throw new PermissionError('Handel nicht gefunden');
  const role = participant?.role ?? null;
  requirePermission(role, action, isAdmin);
  return { trade, participant, role, isAdmin };
}

export function signerIds(parts: ParticipantRow[]): Partial<Record<'buyer' | 'seller' | 'arbiter', number>> {
  const out: Partial<Record<'buyer' | 'seller' | 'arbiter', number>> = {};
  for (const p of parts) if (p.role === 'buyer' || p.role === 'seller' || p.role === 'arbiter') out[p.role] = p.telegram_user_id;
  return out;
}

/** Canonical agreement document; its hash is what every signing party accepts. */
export function agreementContent(trade: TradeRow, parts: ParticipantRow[]): string {
  const s = signerIds(parts);
  return JSON.stringify({
    contract_version: trade.contract_version,
    trade_id: trade.id,
    network: trade.network,
    title: trade.title,
    description: trade.description,
    terms: trade.terms,
    amount_sats: String(trade.amount_sats),
    commission_bps_release: trade.commission_bps,
    commission_bps_refund: trade.refund_commission_bps,
    fee_policy: 'v1: miner fee paid by payout recipient; commission is a separate output; changes require new signatures',
    buyer: s.buyer,
    seller: s.seller,
    arbiter: s.arbiter,
  });
}

/** Moves INVITING → AGREEMENT once buyer, seller and arbiter joined. Creates the agreement snapshot. */
export async function maybeStartAgreement(ctx: ServiceCtx, tradeId: string): Promise<Notice[]> {
  const trade = await getTrade(ctx.db, tradeId);
  if (!trade || trade.status !== 'INVITING') return [];
  const parts = await listParticipants(ctx.db, tradeId);
  const s = signerIds(parts);
  if (!s.buyer || !s.seller || !s.arbiter) return [];
  const content = agreementContent(trade, parts);
  const hash = sha256Hex(content);
  const now = ctx.now();
  await transition(ctx.db, {
    tradeId,
    from: 'INVITING',
    to: 'AGREEMENT',
    expectedVersion: trade.version,
    actorId: 0,
    action: 'agreement_started',
    now,
    set: { sql: 'agreement_hash = ?', params: [hash] },
    followUps: (g, gp) => [
      ctx.db
        .prepare(
          `INSERT INTO trade_agreements (trade_id, version, terms_hash, content_json, created_at)
           SELECT ?, COALESCE((SELECT MAX(version) FROM trade_agreements WHERE trade_id = ?), 0) + 1, ?, ?, ? WHERE ${g}`,
        )
        .bind(tradeId, tradeId, hash, content, now, ...gp),
    ],
  });
  return [s.buyer, s.seller, s.arbiter].map((chatId) => ({
    chatId,
    text: `Handel #${tradeId}: Alle Parteien sind beigetreten. Bitte prüfe und bestätige die Bedingungen.`,
    buttons: [[{ text: 'Bedingungen prüfen', data: `t:${tradeId}:terms` }]],
  }));
}

export async function agreeTerms(ctx: ServiceCtx, userId: number, tradeId: string, shownHash: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'agree_terms');
  if (a.trade.status !== 'AGREEMENT') throw new UserError('Bedingungen können jetzt nicht bestätigt werden.');
  if (!a.trade.agreement_hash || shownHash !== a.trade.agreement_hash.slice(0, 16)) {
    throw new UserError('Die Bedingungen wurden geändert. Bitte erneut prüfen.');
  }
  if (a.participant!.agreed_hash === a.trade.agreement_hash) return [];
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db
      .prepare(`UPDATE participants SET agreed_hash = ?, agreed_at = ? WHERE id = ? AND status = 'active'`)
      .bind(a.trade.agreement_hash, now, a.participant!.id),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'terms_agreed', detail: a.trade.agreement_hash, now }),
  ]);
  const parts = await listParticipants(ctx.db, tradeId);
  const signers = parts.filter((p) => SIGNING_ROLES.has(p.role));
  if (signers.length === 3 && signers.every((p) => p.agreed_hash === a.trade.agreement_hash)) {
    const fresh = await getTrade(ctx.db, tradeId);
    await transition(ctx.db, {
      tradeId, from: 'AGREEMENT', to: 'KEY_SETUP', expectedVersion: fresh!.version, actorId: userId, action: 'all_agreed', now,
    });
    return signers.map((p) => ({
      chatId: p.telegram_user_id,
      text:
        `Handel #${tradeId}: Alle haben zugestimmt. Nächster Schritt: öffentlichen Multisig-Schlüssel registrieren.\n\n` +
        'Benötigt wird ein erweiterter öffentlicher Schlüssel (tpub) mit Key-Origin für eine neue, eigene Wallet ' +
        '(z. B. Sparrow → Neue Wallet → Multisig-Keystore exportieren). Niemals Seed oder privaten Schlüssel senden!',
      buttons: [[{ text: 'Schlüssel registrieren', data: `t:${tradeId}:key` }]],
    }));
  }
  return [];
}

export async function cancelTrade(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'cancel_trade');
  const from = a.trade.status;
  if (FUNDS_AT_RISK_STATES.has(from) || !['DRAFT', 'INVITING', 'AGREEMENT', 'KEY_SETUP', 'READY_TO_FUND'].includes(from)) {
    throw new UserError('Abbruch nicht mehr möglich. Bei Problemen bitte einen Streitfall eröffnen.');
  }
  if (from === 'READY_TO_FUND') {
    const seen = await ctx.db.prepare('SELECT COUNT(*) AS n FROM funding_outputs WHERE trade_id = ?').bind(tradeId).first<{ n: number }>();
    if ((seen?.n ?? 0) > 0) throw new UserError('Es wurde bereits eine Einzahlung erkannt. Abbruch nicht möglich.');
  }
  const now = ctx.now();
  await transition(ctx.db, {
    tradeId, from, to: 'CANCELLED', expectedVersion: a.trade.version, actorId: userId, action: 'trade_cancelled', now,
    followUps: (g, gp) => [
      ctx.db.prepare(`UPDATE invites SET status = 'revoked' WHERE trade_id = ? AND status = 'active' AND ${g}`).bind(tradeId, ...gp),
      ctx.db.prepare(`DELETE FROM scheduled_jobs WHERE trade_id = ? AND ${g}`).bind(tradeId, ...gp),
    ],
  });
  const parts = await listParticipants(ctx.db, tradeId);
  const notices: Notice[] = parts
    .filter((p) => p.telegram_user_id !== userId)
    .map((p) => ({ chatId: p.telegram_user_id, text: `Handel #${tradeId} wurde abgebrochen.` }));
  return [...notices, ...groupNotice(a.trade, 'ABGEBROCHEN')];
}

/** Status-only notice for a linked group chat. Never contains addresses, amounts in detail, keys or PSBTs. */
export function groupNotice(trade: TradeRow, statusLabel: string): Notice[] {
  if (!trade.group_chat_id) return [];
  return [{ chatId: trade.group_chat_id, text: `Handel #${trade.id}: Status ${statusLabel}` }];
}

export async function linkGroup(ctx: ServiceCtx, userId: number, tradeId: string, chatId: number): Promise<void> {
  const a = await authorize(ctx, userId, tradeId, 'link_group');
  if (chatId > 0) throw new UserError('Nur in Gruppen möglich.');
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db.prepare('UPDATE trades SET group_chat_id = ?, updated_at = ? WHERE id = ?').bind(chatId, now, a.trade.id),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'group_linked', now }),
  ]);
}

export function isSigningRole(r: Role | null): r is 'buyer' | 'seller' | 'arbiter' {
  return r === 'buyer' || r === 'seller' || r === 'arbiter';
}

export type { TradeState };
