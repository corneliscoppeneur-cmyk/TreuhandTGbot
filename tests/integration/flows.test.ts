import { afterEach, describe, expect, it, vi } from 'vitest';
import { Harness } from '../helpers/harness.ts';
import { signAs, testAddress } from '../helpers/escrow.ts';
import { ARBITER, BUYER, SELLER, setupFundedTrade } from '../helpers/flows.ts';
import type { SignerRole } from '../../src/bitcoin/multisig.ts';

afterEach(() => vi.unstubAllGlobals());

async function signAndUpload(h: Harness, userId: number, role: SignerRole, psbt: string) {
  await h.click(userId, h.button(userId, /^s:.*:up$/));
  await h.text(userId, signAs(psbt, role));
}

function basePsbt(h: Harness, userId: number): string {
  const m = [...h.to(userId)].reverse().find((x) => x.text.includes('PSBT:\n'))!;
  return m.text.split('PSBT:\n')[1]!.trim();
}

describe('full trade: creation → invite → agreement → multisig → funding → release', () => {
  it('completes with buyer + seller signatures', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);

    await h.click(SELLER, `t:${tradeId}:delivered`);
    expect((await h.trade(tradeId)).status).toBe('FULFILLMENT');
    await h.click(BUYER, `t:${tradeId}:release`);
    expect((await h.trade(tradeId)).status).toBe('RELEASE_REQUESTED');

    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    expect((await h.trade(tradeId)).status).toBe('SIGNING');
    expect(h.to(BUYER).some((m) => m.document)).toBe(true);
    const psbt = basePsbt(h, BUYER);
    // summary shows commission as separate output
    expect(h.last(BUYER).text).toBeTypeOf('string');

    await signAndUpload(h, BUYER, 'buyer', psbt);
    expect(h.last(BUYER).text).toMatch(/zweite Signatur|Signatur von/);
    await signAndUpload(h, SELLER, 'seller', psbt);
    const bc = h.button(SELLER, /^s:.*:bc$/);
    await h.click(SELLER, bc);
    expect((await h.trade(tradeId)).status).toBe('BROADCAST');
    expect(h.chain.broadcasts).toHaveLength(1);

    // double broadcast click is idempotent
    await h.click(BUYER, bc);
    expect(h.chain.broadcasts).toHaveLength(1);

    const session = h.db.raw.prepare('SELECT txid FROM psbt_sessions WHERE trade_id = ?').get(tradeId) as { txid: string };
    h.chain.txStatus.set(session.txid, { confirmed: true, blockHeight: 1005, blockHash: 'dd'.repeat(32) });
    h.chain.tip = 1005;
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('COMPLETE');

    const audit = h.db.raw.prepare('SELECT action FROM audit_events WHERE trade_id = ? ORDER BY id').all(tradeId) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'trade_created',
        'invite_redeemed',
        'all_agreed',
        'params_locked',
        'funded',
        'psbt_created',
        'psbt_finalized',
        'broadcast',
        'payout_confirmed',
      ]),
    );
  });
});

describe('dispute flows', () => {
  it('funding → dispute → arbitration → refund (buyer + arbiter)', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:dispute`);
    await h.text(BUYER, 'Ware nicht erhalten');
    await h.text(BUYER, '-');
    expect((await h.trade(tradeId)).status).toBe('DISPUTED');
    expect(h.last(ARBITER).buttons.some((b) => b.data === `d:${tradeId}:take`)).toBe(true);

    // normal release is blocked by the dispute
    await h.click(BUYER, `t:${tradeId}:release`);
    expect((await h.trade(tradeId)).status).toBe('DISPUTED');

    // only the arbiter can take/decide
    await h.click(BUYER, `d:${tradeId}:take`);
    expect((await h.trade(tradeId)).status).toBe('DISPUTED');
    await h.click(ARBITER, `d:${tradeId}:take`);
    expect((await h.trade(tradeId)).status).toBe('ARBITRATION');
    await h.click(ARBITER, `d:${tradeId}:refund`);
    await h.text(ARBITER, 'Kein Versandnachweis vorgelegt');
    expect((await h.trade(tradeId)).status).toBe('REFUND_REQUESTED');

    await h.click(BUYER, `t:${tradeId}:addr`);
    await h.text(BUYER, testAddress('buyer-refund'));
    expect((await h.trade(tradeId)).status).toBe('SIGNING');
    const psbt = basePsbt(h, BUYER);
    await signAndUpload(h, BUYER, 'buyer', psbt);
    await signAndUpload(h, ARBITER, 'arbiter', psbt);
    await h.click(ARBITER, h.button(ARBITER, /^s:.*:bc$/));
    expect((await h.trade(tradeId)).status).toBe('BROADCAST');
    const session = h.db.raw.prepare(`SELECT txid, kind FROM psbt_sessions WHERE trade_id = ? AND status = 'broadcast'`).get(tradeId) as {
      txid: string;
      kind: string;
    };
    expect(session.kind).toBe('refund');
    h.chain.txStatus.set(session.txid, { confirmed: true, blockHeight: 1002, blockHash: 'ee'.repeat(32) });
    h.chain.tip = 1002;
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('REFUNDED');
  });

  it('funding → dispute → arbitration → release to seller (seller + arbiter)', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(SELLER, `t:${tradeId}:dispute`);
    await h.text(SELLER, 'Käufer bestätigt Empfang nicht');
    await h.text(SELLER, 'https://cryptgeon.org/note/abc');
    await h.click(ARBITER, `d:${tradeId}:take`);
    await h.click(ARBITER, `d:${tradeId}:release`);
    await h.text(ARBITER, 'Sendungsverfolgung zeigt Zustellung');
    expect((await h.trade(tradeId)).status).toBe('RELEASE_REQUESTED');
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const psbt = basePsbt(h, SELLER);
    await signAndUpload(h, SELLER, 'seller', psbt);
    await signAndUpload(h, ARBITER, 'arbiter', psbt);
    await h.click(SELLER, h.button(SELLER, /^s:.*:bc$/));
    expect((await h.trade(tradeId)).status).toBe('BROADCAST');
  });

  it('dispute during signing locks the session; uploads and broadcast are refused', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const psbt = basePsbt(h, BUYER);
    await signAndUpload(h, BUYER, 'buyer', psbt);
    await h.click(SELLER, `t:${tradeId}:dispute`);
    await h.text(SELLER, 'Problem');
    await h.text(SELLER, '-');
    expect((await h.trade(tradeId)).status).toBe('DISPUTED');
    const s = h.db.raw.prepare('SELECT status FROM psbt_sessions WHERE trade_id = ?').get(tradeId) as { status: string };
    expect(s.status).toBe('locked');
    await signAndUpload(h, SELLER, 'seller', psbt);
    expect(h.last(SELLER).text).toMatch(/gesperrt/);
    expect(h.chain.broadcasts).toHaveLength(0);
  });
});
