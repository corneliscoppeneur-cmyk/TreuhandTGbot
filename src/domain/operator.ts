import { DUST_LIMIT_SATS } from '../config/constants.ts';
import { deriveChildPubkey, formatPath, parseSignerKey, type SignerKey } from '../bitcoin/descriptor.ts';
import { ESCROW_INDEX } from '../config/constants.ts';
import { hex } from '@scure/base';
import type { Db, DbStatement } from '../database/client.ts';
import type { Button, Notice, ServiceCtx } from './context.ts';

/**
 * Operator mode: the operator is automatically the arbiter (third key) of every trade.
 * Routine arbiter steps (agreeing to the platform's standard role, key registration,
 * address verification) are done by the bot with the operator's PUBLIC key; only dispute
 * decisions need the operator, who signs with their own wallet. No private key is on the server.
 */
export function operatorMode(ctx: ServiceCtx): boolean {
  return ctx.cfg.operatorId !== null && ctx.cfg.operatorArbiterKey !== null;
}

export function operatorKey(ctx: ServiceCtx): SignerKey {
  return parseSignerKey(ctx.cfg.operatorArbiterKey!, ctx.net);
}

/** Upfront fee for a trade amount: percentage of the amount, at least the dust limit (0 if fees are off). */
export function upfrontFeeSats(ctx: ServiceCtx, amountSats: bigint): bigint {
  if (!ctx.cfg.commissionXpub || ctx.cfg.commissionBps === 0) return 0n;
  const fee = (amountSats * BigInt(ctx.cfg.commissionBps)) / 10_000n;
  return fee < DUST_LIMIT_SATS ? DUST_LIMIT_SATS : fee;
}

/** Statements that add the operator as arbiter participant of a new trade. */
export function addOperatorStmts(ctx: ServiceCtx, tradeId: string, now: number): DbStatement[] {
  const id = ctx.cfg.operatorId!;
  return [
    ctx.db
      .prepare(`INSERT OR IGNORE INTO users (telegram_user_id, username, first_seen_at, last_seen_at) VALUES (?, 'operator', ?, ?)`)
      .bind(id, now, now),
    ctx.db
      .prepare(`INSERT INTO participants (trade_id, telegram_user_id, role, joined_at) VALUES (?, ?, 'arbiter', ?)`)
      .bind(tradeId, id, now),
  ];
}

/** Statement registering the operator's arbiter key for a trade (public data only). Guarded like transition follow-ups. */
export function operatorKeyStmt(
  db: Db,
  ctx: ServiceCtx,
  tradeId: string,
  now: number,
  guardSql: string,
  guardParams: unknown[],
): DbStatement {
  const k = operatorKey(ctx);
  return db
    .prepare(
      `INSERT OR IGNORE INTO signers_public
         (trade_id, role, telegram_user_id, fingerprint, derivation_path, xpub, escrow_pubkey_hex, is_operator, created_at)
       SELECT ?, 'arbiter', ?, ?, ?, ?, ?, 1, ? WHERE ${guardSql}`,
    )
    .bind(
      tradeId,
      ctx.cfg.operatorId,
      k.fingerprint,
      formatPath(k.path),
      k.xpub,
      hex.encode(deriveChildPubkey(k, ctx.net, ESCROW_INDEX)),
      now,
      ...guardParams,
    );
}

/** Notices for all admins (the operator is always an admin). */
export function adminNotices(ctx: ServiceCtx, text: string, buttons?: Button[][]): Notice[] {
  return [...ctx.cfg.adminIds].map((chatId) => ({ chatId, text: `🛎 Admin: ${text}`, ...(buttons ? { buttons } : {}) }));
}

/** True if this chat id is the operator acting as automatic arbiter (routine notices are skipped). */
export function isOperator(ctx: ServiceCtx, chatId: number | undefined): boolean {
  return ctx.cfg.operatorId !== null && chatId === ctx.cfg.operatorId;
}
