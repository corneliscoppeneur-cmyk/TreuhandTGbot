/** TEST-ONLY: drives trades through the real Telegram handlers. */
import { expect } from 'vitest';
import type { SignerRole } from '../../src/bitcoin/multisig.ts';
import { wallets } from './escrow.ts';
import type { Harness } from './harness.ts';

export const BUYER = 1001;
export const SELLER = 1002;
export const ARBITER = 1003;
export const IDS: Record<SignerRole, number> = { buyer: BUYER, seller: SELLER, arbiter: ARBITER };

export async function inviteAndJoin(h: Harness, tradeId: string, role: string, userId: number, inviter = BUYER) {
  await h.click(inviter, `i:${tradeId}:${role}`);
  const msg = h.last(inviter).text;
  const token = /start=i_([A-Za-z0-9_-]{43})/.exec(msg)![1]!;
  const code = /Zugangscode[^:]*: ([A-Z0-9]{8})/.exec(msg)![1]!;
  await h.text(userId, `/start i_${token}`);
  await h.text(userId, code);
  return { token, code };
}

/** Drives a trade from creation to FUNDED via the real Telegram handlers. */
export async function setupFundedTrade(h: Harness): Promise<{ tradeId: string; address: string }> {
  await h.text(BUYER, '/newtrade');
  await h.text(BUYER, 'Testhandel Laptop');
  await h.text(BUYER, 'Gebrauchter Laptop, Versand per Post');
  await h.text(BUYER, '0,01');
  await h.text(BUYER, 'Lieferung binnen 7 Tagen');
  await h.click(BUYER, 'n:role:buyer');
  await h.click(BUYER, 'n:confirm');
  const tradeId = /Handel #([A-Z0-9]{8}) erstellt/.exec(h.last(BUYER).text)![1]!;
  expect((await h.trade(tradeId)).status).toBe('INVITING');

  await inviteAndJoin(h, tradeId, 'seller', SELLER);
  await inviteAndJoin(h, tradeId, 'arbiter', ARBITER);
  expect((await h.trade(tradeId)).status).toBe('AGREEMENT');

  for (const id of [BUYER, SELLER, ARBITER]) {
    await h.click(id, `t:${tradeId}:terms`);
    await h.click(id, h.button(id, /:agree:/));
  }
  expect((await h.trade(tradeId)).status).toBe('KEY_SETUP');

  for (const role of ['buyer', 'seller', 'arbiter'] as const) {
    await h.click(IDS[role], `t:${tradeId}:key`);
    await h.text(IDS[role], wallets[role].keyExpression);
  }
  const verifyText = h.last(ARBITER).text;
  const address = /\n(tb1q[0-9a-z]{58})\n/.exec(verifyText)![1]!;
  for (const id of [BUYER, SELLER, ARBITER]) await h.click(id, h.button(id, /:verify:/));
  expect((await h.trade(tradeId)).status).toBe('READY_TO_FUND');
  expect(h.last(BUYER).text).toContain(address);

  h.chain.pay(address, 'cc'.repeat(32), 1_010_000n);
  await h.cron();
  expect((await h.trade(tradeId)).status).toBe('FUNDING_SEEN');
  h.chain.tip = 1001;
  h.chain.confirmAll(address, 1001);
  await h.cron();
  expect((await h.trade(tradeId)).status).toBe('FUNDED');
  return { tradeId, address };
}
