import { INVITE_MAX_ATTEMPTS, INVITE_TTL_SECONDS, USER_MAX_FAILED_ATTEMPTS_PER_HOUR } from '../config/constants.ts';
import { auditStmt, listParticipants, type InviteRow } from '../database/repo.ts';
import { hmacHex, isInviteTokenFormat, newAccessCode, newInviteToken, safeEqual } from '../security/tokens.ts';
import type { Notice, ServiceCtx } from './context.ts';
import { UserError } from './context.ts';
import { ROLE_LABEL_DE, SIGNING_ROLES, type Role } from './permissions.ts';
import { authorize, maybeStartAgreement } from './trade.ts';
import { isOperator } from './operator.ts';

export interface CreatedInvite {
  link: string;
  accessCode: string;
  role: Role;
  expiresAt: number;
}

/** States in which new participants may still join. Observers/mediators may join later too. */
const JOINABLE: Record<'signer' | 'other', string[]> = {
  signer: ['INVITING'],
  other: ['INVITING', 'AGREEMENT', 'KEY_SETUP', 'READY_TO_FUND', 'FUNDING_SEEN', 'FUNDED', 'FULFILLMENT'],
};

export async function createInvite(ctx: ServiceCtx, userId: number, tradeId: string, role: Role): Promise<CreatedInvite> {
  const a = await authorize(ctx, userId, tradeId, 'invite');
  if (role === 'arbiter' && ctx.cfg.operatorId !== null) {
    throw new UserError('Der Schlichter ist bei diesem Bot automatisch der Betreiber – du musst niemanden einladen.');
  }
  const signer = SIGNING_ROLES.has(role);
  if (!JOINABLE[signer ? 'signer' : 'other'].includes(a.trade.status)) {
    throw new UserError('In diesem Status sind keine Einladungen für diese Rolle möglich.');
  }
  if (signer) {
    const parts = await listParticipants(ctx.db, tradeId);
    if (parts.some((p) => p.role === role)) throw new UserError(`Rolle ${ROLE_LABEL_DE[role]} ist bereits besetzt.`);
  }
  const token = newInviteToken();
  const code = newAccessCode();
  const now = ctx.now();
  const expiresAt = now + INVITE_TTL_SECONDS;
  await ctx.db.batch([
    // only one active invite per signer role: revoke older ones
    ...(signer
      ? [ctx.db.prepare(`UPDATE invites SET status = 'revoked' WHERE trade_id = ? AND role = ? AND status = 'active'`).bind(tradeId, role)]
      : []),
    ctx.db
      .prepare(
        `INSERT INTO invites (trade_id, role, token_hash, code_hash, max_uses, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        tradeId,
        role,
        hmacHex(ctx.cfg.inviteHmacSecret, 'invite', token),
        hmacHex(ctx.cfg.inviteHmacSecret, 'code', code),
        expiresAt,
        userId,
        now,
      ),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'invite_created', detail: role, now }),
  ]);
  return { link: `https://t.me/${ctx.cfg.botUsername}?start=i_${token}`, accessCode: code, role, expiresAt };
}

async function recentFailures(ctx: ServiceCtx, userId: number): Promise<number> {
  const r = await ctx.db
    .prepare('SELECT COUNT(*) AS n FROM access_attempts WHERE telegram_user_id = ? AND success = 0 AND created_at > ?')
    .bind(userId, ctx.now() - 3600)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

async function findInvite(ctx: ServiceCtx, token: string): Promise<InviteRow | null> {
  if (!isInviteTokenFormat(token)) return null;
  return ctx.db
    .prepare('SELECT * FROM invites WHERE token_hash = ?')
    .bind(hmacHex(ctx.cfg.inviteHmacSecret, 'invite', token))
    .first<InviteRow>();
}

function assertUsable(inv: InviteRow | null, userId: number, now: number): InviteRow {
  if (!inv || inv.status !== 'active' || inv.expires_at <= now || inv.uses >= inv.max_uses) {
    throw new UserError('Einladung ungültig, abgelaufen oder bereits verwendet.');
  }
  if (inv.bound_user_id !== null && inv.bound_user_id !== userId) throw new UserError('Diese Einladung ist an ein anderes Konto gebunden.');
  if (inv.attempts >= INVITE_MAX_ATTEMPTS) throw new UserError('Einladung gesperrt (zu viele Fehlversuche).');
  return inv;
}

/** Step 1 of redemption: validates the deep-link token and binds the invite to this Telegram account. */
export async function startRedeem(
  ctx: ServiceCtx,
  userId: number,
  token: string,
): Promise<{ inviteId: number; tradeId: string; role: Role }> {
  if ((await recentFailures(ctx, userId)) >= USER_MAX_FAILED_ATTEMPTS_PER_HOUR) {
    throw new UserError('Zu viele Fehlversuche. Bitte später erneut versuchen.');
  }
  const now = ctx.now();
  const inv = await findInvite(ctx, token);
  if (!inv) {
    await ctx.db.prepare('INSERT INTO access_attempts (telegram_user_id, success, created_at) VALUES (?, 0, ?)').bind(userId, now).run();
    throw new UserError('Einladung ungültig, abgelaufen oder bereits verwendet.');
  }
  assertUsable(inv, userId, now);
  // Bind to the first account that opens the link; a leaked link cannot be redeemed by someone else afterwards.
  const r = await ctx.db
    .prepare(`UPDATE invites SET bound_user_id = ? WHERE id = ? AND status = 'active' AND (bound_user_id IS NULL OR bound_user_id = ?)`)
    .bind(userId, inv.id, userId)
    .run();
  if (r.meta.changes !== 1) throw new UserError('Diese Einladung ist an ein anderes Konto gebunden.');
  return { inviteId: inv.id, tradeId: inv.trade_id, role: inv.role };
}

/** Step 2: verifies the one-time access code and joins the trade atomically. */
export async function submitAccessCode(ctx: ServiceCtx, userId: number, inviteId: number, code: string): Promise<Notice[]> {
  const now = ctx.now();
  if ((await recentFailures(ctx, userId)) >= USER_MAX_FAILED_ATTEMPTS_PER_HOUR) {
    throw new UserError('Zu viele Fehlversuche. Bitte später erneut versuchen.');
  }
  const inv = assertUsable(await ctx.db.prepare('SELECT * FROM invites WHERE id = ?').bind(inviteId).first<InviteRow>(), userId, now);
  if (inv.bound_user_id !== userId) throw new UserError('Bitte den Einladungslink erneut öffnen.');

  const normalized = code.trim().toUpperCase().replace(/[\s-]/g, '');
  const ok = inv.code_hash !== null && safeEqual(hmacHex(ctx.cfg.inviteHmacSecret, 'code', normalized), inv.code_hash);
  if (!ok) {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE invites SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ? THEN 'revoked' ELSE status END WHERE id = ?`,
        )
        .bind(INVITE_MAX_ATTEMPTS, inv.id),
      ctx.db
        .prepare('INSERT INTO access_attempts (telegram_user_id, invite_id, success, created_at) VALUES (?, ?, 0, ?)')
        .bind(userId, inv.id, now),
    ]);
    const left = INVITE_MAX_ATTEMPTS - inv.attempts - 1;
    throw new UserError(left > 0 ? `Zugangscode falsch. Verbleibende Versuche: ${left}` : 'Zugangscode falsch. Einladung wurde gesperrt.');
  }

  const existing = await ctx.db
    .prepare(`SELECT role FROM participants WHERE trade_id = ? AND telegram_user_id = ? AND status = 'active'`)
    .bind(inv.trade_id, userId)
    .first<{ role: Role }>();
  if (existing)
    throw new UserError(`Du bist in diesem Handel bereits ${ROLE_LABEL_DE[existing.role]}. Eine Person darf nur eine Rolle haben.`);

  const trade = await ctx.db.prepare('SELECT status FROM trades WHERE id = ?').bind(inv.trade_id).first<{ status: string }>();
  const signer = SIGNING_ROLES.has(inv.role);
  if (!trade || !JOINABLE[signer ? 'signer' : 'other'].includes(trade.status))
    throw new UserError('Beitritt in diesem Status nicht mehr möglich.');

  let res;
  try {
    res = await ctx.db.batch([
      ctx.db
        .prepare(
          `UPDATE invites SET uses = uses + 1, redeemed_at = ?, redeemed_by = ?,
             status = CASE WHEN uses + 1 >= max_uses THEN 'used' ELSE status END
           WHERE id = ? AND status = 'active' AND uses < max_uses AND bound_user_id = ?`,
        )
        .bind(now, userId, inv.id, userId),
      ctx.db
        .prepare('INSERT INTO participants (trade_id, telegram_user_id, role, joined_at) SELECT ?, ?, ?, ? WHERE changes() = 1')
        .bind(inv.trade_id, userId, inv.role, now),
      ctx.db
        .prepare('INSERT INTO access_attempts (telegram_user_id, invite_id, success, created_at) VALUES (?, ?, 1, ?)')
        .bind(userId, inv.id, now),
      auditStmt(ctx.db, { tradeId: inv.trade_id, actorId: userId, action: 'invite_redeemed', detail: inv.role, now }),
    ]);
  } catch {
    // UNIQUE violation: role slot taken concurrently
    throw new UserError('Diese Rolle wurde inzwischen besetzt.');
  }
  if (res[0]?.meta.changes !== 1) throw new UserError('Einladung wurde bereits verwendet.');

  const parts = await listParticipants(ctx.db, inv.trade_id);
  const notices: Notice[] = parts
    .filter((p) => p.telegram_user_id !== userId && SIGNING_ROLES.has(p.role) && !isOperator(ctx, p.telegram_user_id))
    .map((p) => ({
      chatId: p.telegram_user_id,
      text: `Handel #${inv.trade_id}: Neuer Teilnehmer als ${ROLE_LABEL_DE[inv.role]} beigetreten.`,
    }));
  notices.push({
    chatId: userId,
    text:
      `✅ Willkommen! Du bist jetzt ${ROLE_LABEL_DE[inv.role]} in Handel #${inv.trade_id}.\n\n` +
      'Öffne den Handel, um Titel, Betrag und Bedingungen zu sehen. Dort steht immer auch dein nächster Schritt.' +
      (SIGNING_ROLES.has(inv.role)
        ? '\n\nTipp: Du brauchst gleich eine eigene Bitcoin-Wallet. Noch keine? Tippe auf „Wallet einrichten“.'
        : ''),
    buttons: [
      [{ text: '📂 Handel öffnen', data: `t:${inv.trade_id}:view`, style: 'primary' }],
      ...(SIGNING_ROLES.has(inv.role) ? [[{ text: '👛 Wallet einrichten', data: 'm:wallet' }]] : []),
    ],
  });
  return [...notices, ...(await maybeStartAgreement(ctx, inv.trade_id))];
}

export async function listInvites(ctx: ServiceCtx, userId: number, tradeId: string): Promise<InviteRow[]> {
  await authorize(ctx, userId, tradeId, 'invite');
  const r = await ctx.db
    .prepare(`SELECT * FROM invites WHERE trade_id = ? AND status = 'active' AND expires_at > ? ORDER BY id DESC LIMIT 20`)
    .bind(tradeId, ctx.now())
    .all<InviteRow>();
  return r.results;
}

export async function revokeInvite(ctx: ServiceCtx, userId: number, tradeId: string, inviteId: number): Promise<void> {
  await authorize(ctx, userId, tradeId, 'revoke_invite');
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db.prepare(`UPDATE invites SET status = 'revoked' WHERE id = ? AND trade_id = ? AND status = 'active'`).bind(inviteId, tradeId),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'invite_revoked', detail: String(inviteId), now }),
  ]);
}
