import { CONVERSATION_TTL_SECONDS } from '../config/constants.ts';
import type { Db } from '../database/client.ts';

/** Multi-step private dialogs. State lives in D1 (Workers are stateless) and expires after 30 min. */
export type Flow =
  | { flow: 'newtrade'; step: 'title' | 'description' | 'amount' | 'terms' | 'role' | 'confirm'; data: NewTradeDraft }
  | { flow: 'invite_code'; step: 'code'; data: { inviteId: number } }
  | { flow: 'key'; step: 'key'; data: { tradeId: string } }
  | { flow: 'addr'; step: 'addr'; data: { tradeId: string } }
  | { flow: 'psbt'; step: 'psbt'; data: { sessionId: string } }
  | { flow: 'dispute'; step: 'reason' | 'links'; data: { tradeId: string; reason?: string } }
  | { flow: 'dnote'; step: 'note'; data: { tradeId: string } }
  | { flow: 'decide'; step: 'note'; data: { tradeId: string; decision: 'release' | 'refund' } };

export interface NewTradeDraft {
  title?: string;
  description?: string;
  amountSats?: string;
  terms?: string;
  role?: 'buyer' | 'seller';
}

export async function getFlow(db: Db, userId: number, now: number): Promise<Flow | null> {
  const r = await db
    .prepare('SELECT flow, step, data_json FROM conversation_state WHERE telegram_user_id = ? AND expires_at > ?')
    .bind(userId, now)
    .first<{ flow: string; step: string; data_json: string }>();
  if (!r) return null;
  try {
    return { flow: r.flow, step: r.step, data: JSON.parse(r.data_json) } as Flow;
  } catch {
    return null;
  }
}

export async function setFlow(db: Db, userId: number, f: Flow, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO conversation_state (telegram_user_id, flow, step, data_json, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO UPDATE SET flow = excluded.flow, step = excluded.step, data_json = excluded.data_json, expires_at = excluded.expires_at`,
    )
    .bind(userId, f.flow, f.step, JSON.stringify(f.data), now + CONVERSATION_TTL_SECONDS)
    .run();
}

export async function clearFlow(db: Db, userId: number): Promise<void> {
  await db.prepare('DELETE FROM conversation_state WHERE telegram_user_id = ?').bind(userId).run();
}
