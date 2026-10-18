import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { Harness, testEnv } from '../helpers/harness.ts';
import { BUYER, SELLER, inviteAndJoin } from '../helpers/flows.ts';
import { signAs, testAddress, wallets } from '../helpers/escrow.ts';
import { testWallet } from '../helpers/keys.ts';
import { parseConfig, ConfigError } from '../../src/config/env.ts';
import { serviceFeeSats } from '../../src/domain/operator.ts';
import type { ServiceCtx } from '../../src/domain/context.ts';

afterEach(() => vi.unstubAllGlobals());

const OPERATOR = 9000;
const operatorWallet = testWallet('operator');
const COMMISSION = testAddress('operator'); // = COMMISSION_ADDRESS of the test env

function opHarness(): Harness {
  return new Harness({ OPERATOR_TELEGRAM_ID: String(OPERATOR), OPERATOR_ARBITER_KEY: operatorWallet.keyExpression });
}

function signAsOperator(psbt: string): string {
  const tx = Transaction.fromPSBT(base64.decode(psbt));
  for (let i = 0; i < tx.inputsLength; i++) tx.signIdx(operatorWallet.escrowPrivKey, i);
  return base64.encode(tx.toPSBT());
}

async function newTrade(h: Harness): Promise<string> {
  await h.text(BUYER, '/newtrade');
  for (const t of ['Fahrrad', 'Rennrad 56 cm', '0,01', 'Abholung']) await h.text(BUYER, t);
  await h.click(BUYER, 'n:role:buyer');
  await h.click(BUYER, 'n:confirm');
  return /Handel #([A-Z0-9]{8}) erstellt/.exec(h.last(BUYER).text)![1]!;
}

/** Operator mode: only buyer and seller act; the operator is arbiter automatically. */
async function readyToFund(h: Harness, account = 0) {
  const tradeId = await newTrade(h);
  await inviteAndJoin(h, tradeId, 'seller', SELLER);
  expect((await h.trade(tradeId)).status).toBe('AGREEMENT');
  for (const id of [BUYER, SELLER]) {
    await h.click(id, `t:${tradeId}:terms`);
    await h.click(id, h.button(id, /:agree:/));
  }
  expect((await h.trade(tradeId)).status).toBe('KEY_SETUP');
  for (const [id, role] of [
    [BUYER, 'buyer'],
    [SELLER, 'seller'],
  ] as const) {
    await h.click(id, `t:${tradeId}:key`);
    // a fresh wallet account per trade (the bot refuses reused keys)
    await h.text(id, account === 0 ? wallets[role].keyExpression : testWallet(role, account).keyExpression);
  }
  for (const id of [BUYER, SELLER]) await h.click(id, h.button(id, /:verify:/));
  expect((await h.trade(tradeId)).status).toBe('READY_TO_FUND');
  const escrow = (h.db.raw.prepare('SELECT address FROM multisig_configs WHERE trade_id = ?').get(tradeId) as { address: string }).address;
  return { tradeId, escrow };
}

/** One payment: trade amount 0,01 BTC + 1 % service fee. */
const TOTAL = 1_010_000n;

async function fund(h: Harness, escrow: string, value = TOTAL) {
  h.chain.pay(escrow, 'c1'.repeat(32), value);
  h.chain.tip = 1001;
  h.chain.confirmAll(escrow, 1001);
  await h.cron();
}

describe('service fee', () => {
  const ctx = (bps: string) =>
    ({ cfg: parseConfig({ ...(testEnv() as unknown as Record<string, unknown>), DEFAULT_COMMISSION_BPS: bps }) }) as ServiceCtx;
  it('is a percentage of the amount, at least the dust limit, 0 when disabled', () => {
    expect(serviceFeeSats(ctx('100'), 1_000_000n)).toBe(10_000n);
    expect(serviceFeeSats(ctx('100'), 20_000n)).toBe(546n);
    expect(serviceFeeSats(ctx('0'), 1_000_000n)).toBe(0n);
  });
  it('operator id and key must be set together', async () => {
    expect(() => parseConfig({ ...(testEnv() as unknown as Record<string, unknown>), OPERATOR_TELEGRAM_ID: '1' })).toThrow(ConfigError);
    const h = new Harness({ OPERATOR_TELEGRAM_ID: '1', OPERATOR_ARBITER_KEY: 'nonsense' });
    expect((await h.text(BUYER, '/start')).status).toBe(503);
  });
});

describe('operator is the automatic arbiter', () => {
  it('joins every trade automatically; arbiter invites are refused; operator cannot be buyer/seller', async () => {
    const h = opHarness();
    const id = await newTrade(h);
    const arb = h.db.raw.prepare(`SELECT telegram_user_id FROM participants WHERE trade_id = ? AND role = 'arbiter'`).get(id) as {
      telegram_user_id: number;
    };
    expect(arb.telegram_user_id).toBe(OPERATOR);
    expect(h.to(OPERATOR).some((m) => m.text.includes('Neuer Handel'))).toBe(true);
    await h.click(BUYER, `i:${id}:arbiter`);
    expect(h.last(BUYER).text).toMatch(/automatisch der Betreiber/);
    await h.click(BUYER, `t:${id}:inv`);
    expect(h.last(BUYER).buttons.some((b) => b.data?.endsWith(':arbiter'))).toBe(false);

    await h.text(OPERATOR, '/newtrade');
    for (const t of ['x', 'y', '0,01', 'z']) await h.text(OPERATOR, t);
    await h.click(OPERATOR, 'n:role:buyer');
    await h.click(OPERATOR, 'n:confirm');
    expect(h.last(OPERATOR).text).toMatch(/automatisch Schlichter/);
  });

  it('routine steps run without the operator; deposit is ONE address and ONE sum', async () => {
    const h = opHarness();
    const before = h.sent.length;
    const { escrow, tradeId } = await readyToFund(h);
    expect(h.to(OPERATOR, before).every((m) => m.text.startsWith('🛎 Admin'))).toBe(true);
    expect(Number((await h.trade(tradeId)).fee_sats)).toBe(10_000);
    const dep = h.to(BUYER).find((m) => m.text.includes('Bereit zur Einzahlung'))!;
    expect(dep.text).toContain(escrow);
    expect(dep.text).toContain('0,01010000 BTC');
    expect(dep.text).not.toContain(COMMISSION);
    expect(dep.buttons.filter((b) => b.copy).map((b) => b.copy)).toEqual([escrow, '0.01010000']);
  });

  it('funded only when amount + fee arrived; the amount alone is a partial payment', async () => {
    const h = opHarness();
    const { tradeId, escrow } = await readyToFund(h);
    await fund(h, escrow, 1_000_000n);
    expect((await h.trade(tradeId)).status).toBe('FUNDING_SEEN');
    expect(h.last(BUYER).text).toMatch(/Teilzahlung/);
    h.chain.pay(escrow, 'c2'.repeat(32), 10_000n);
    h.chain.tip = 1002;
    h.chain.confirmAll(escrow, 1002);
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDED');
  });

  it('release: the fee goes to the operator as its own output; buyer + seller sign; operator not bothered', async () => {
    const h = opHarness();
    const { tradeId, escrow } = await readyToFund(h);
    await fund(h, escrow);
    const opBefore = h.to(OPERATOR).length;
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const s = h.db.raw.prepare('SELECT outputs_json, miner_fee_sats FROM psbt_sessions WHERE trade_id = ?').get(tradeId) as {
      outputs_json: string;
      miner_fee_sats: number;
    };
    const outs = JSON.parse(s.outputs_json) as { purpose: string; address: string; valueSats: string }[];
    expect(outs).toHaveLength(2);
    expect(outs.find((o) => o.purpose === 'commission')).toMatchObject({ address: COMMISSION, valueSats: '10000' });
    expect(BigInt(outs.find((o) => o.purpose === 'recipient')!.valueSats)).toBe(1_000_000n - BigInt(s.miner_fee_sats));
    const psbt = h.psbt(BUYER);
    for (const [id, role] of [
      [BUYER, 'buyer'],
      [SELLER, 'seller'],
    ] as const) {
      await h.click(id, h.button(id, /^s:.*:up$/));
      await h.text(id, signAs(psbt, role));
    }
    await h.click(SELLER, h.button(SELLER, /^s:.*:bc$/));
    expect((await h.trade(tradeId)).status).toBe('BROADCAST');
    expect(
      h
        .to(OPERATOR)
        .slice(opBefore)
        .every((m) => m.text.startsWith('🛎 Admin')),
    ).toBe(true);
  });

  it('dispute → operator decides refund, fee is kept, operator signs with the buyer', async () => {
    const h = opHarness();
    const { tradeId, escrow } = await readyToFund(h);
    await fund(h, escrow);
    await h.click(BUYER, `t:${tradeId}:dispute`);
    await h.text(BUYER, 'Rad hat Rahmenbruch');
    await h.text(BUYER, '-');
    expect(h.to(OPERATOR).some((m) => m.buttons.some((b) => b.data === `d:${tradeId}:take`))).toBe(true);
    await h.click(OPERATOR, `d:${tradeId}:take`);
    await h.click(OPERATOR, `d:${tradeId}:refund`);
    await h.text(OPERATOR, 'Mangel belegt');
    await h.click(BUYER, `t:${tradeId}:addr`);
    await h.text(BUYER, testAddress('buyer-refund'));
    const s = h.db.raw.prepare('SELECT outputs_json FROM psbt_sessions WHERE trade_id = ?').get(tradeId) as { outputs_json: string };
    expect(JSON.parse(s.outputs_json).find((o: { purpose: string }) => o.purpose === 'commission')).toMatchObject({ valueSats: '10000' });
    const psbt = h.psbt(OPERATOR); // operator receives the PSBT after a dispute decision
    await h.click(BUYER, h.button(BUYER, /^s:.*:up$/));
    await h.text(BUYER, signAs(psbt, 'buyer'));
    await h.click(OPERATOR, h.button(OPERATOR, /^s:.*:up$/));
    await h.text(OPERATOR, signAsOperator(psbt));
    await h.click(OPERATOR, h.button(OPERATOR, /^s:.*:bc$/));
    expect((await h.trade(tradeId)).status).toBe('BROADCAST');
  });

  it('bypassing the bot blocks buyer and seller and alerts the operator', async () => {
    const h = opHarness();
    const { tradeId, escrow } = await readyToFund(h);
    await fund(h, escrow);
    h.chain.utxos.set(escrow, []);
    h.chain.outspends.set(`${'c1'.repeat(32)}:0`, { spent: true, spendingTxid: '77'.repeat(32) });
    await h.cron(3600);
    expect((await h.trade(tradeId)).status).toBe('NEEDS_REVIEW');
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM users WHERE is_blocked = 1').get()).toEqual({ n: 2 });
    expect(h.to(OPERATOR).some((m) => /am Bot vorbei/.test(m.text))).toBe(true);
  });

  it('works for several trades in a row (operator key reused, buyer keys fresh)', async () => {
    const h = opHarness();
    await readyToFund(h);
    const second = await readyToFund(h, 1);
    expect(second.escrow).toMatch(/^tb1q/);
  });
});
