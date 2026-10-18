import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Harness } from '../helpers/harness.ts';
import { BUYER, SELLER, inviteAndJoin } from '../helpers/flows.ts';
import { signAs, testAddress, wallets } from '../helpers/escrow.ts';
import { NET, testWallet } from '../helpers/keys.ts';
import { feeAddress, parseFeeXpub } from '../../src/bitcoin/fee-wallet.ts';
import { parseConfig, ConfigError } from '../../src/config/env.ts';
import { testEnv } from '../helpers/harness.ts';

afterEach(() => vi.unstubAllGlobals());

const OPERATOR = 9000;
const operatorWallet = testWallet('operator');
/** TEST-ONLY BIP-84 fee wallet of the operator. */
const feeRoot = HDKey.fromMasterSeed(sha256(utf8ToBytes('TEST-ONLY-fee-wallet')), { public: 0x043587cf, private: 0x04358394 });
const FEE_XPUB = feeRoot.derive("m/84'/1'/0'").publicExtendedKey;

function opHarness(): Harness {
  return new Harness({
    OPERATOR_TELEGRAM_ID: String(OPERATOR),
    OPERATOR_ARBITER_KEY: operatorWallet.keyExpression,
    COMMISSION_XPUB: FEE_XPUB,
  });
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
  const t = await h.trade(tradeId);
  expect(t.status).toBe('READY_TO_FUND');
  const escrow = (h.db.raw.prepare('SELECT address FROM multisig_configs WHERE trade_id = ?').get(tradeId) as { address: string }).address;
  return { tradeId, escrow, feeAddr: String(t.fee_address), feeSats: BigInt(Number(t.fee_sats)) };
}

async function fund(h: Harness, escrow: string, feeAddr: string, feeSats: bigint) {
  h.chain.pay(escrow, 'c1'.repeat(32), 1_000_000n);
  h.chain.tip = 1001;
  h.chain.confirmAll(escrow, 1001);
  h.chain.received.set(feeAddr, { confirmedSats: feeSats, mempoolSats: 0n });
  await h.cron();
}

describe('operator mode configuration', () => {
  it('requires operator id and key together and a valid fee xpub', async () => {
    const raw = testEnv() as unknown as Record<string, unknown>;
    expect(() => parseConfig({ ...raw, OPERATOR_TELEGRAM_ID: '1' })).toThrow(ConfigError);
    const h = new Harness({ OPERATOR_TELEGRAM_ID: '1', OPERATOR_ARBITER_KEY: 'nonsense' });
    expect((await h.text(BUYER, '/start')).status).toBe(503);
    const h2 = new Harness({ COMMISSION_XPUB: 'xpubnonsense' });
    expect((await h2.text(BUYER, '/start')).status).toBe(503);
  });

  it('fee addresses are deterministic, valid and different per trade', () => {
    const x = parseFeeXpub(FEE_XPUB, NET);
    const a0 = feeAddress(x, NET, 0);
    const a1 = feeAddress(x, NET, 1);
    expect(a0).toMatch(/^tb1q[0-9a-z]{38}$/);
    expect(a0).not.toBe(a1);
    expect(feeAddress(x, NET, 0)).toBe(a0);
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

  it('routine steps run without the operator; deposit asks for two payments', async () => {
    const h = opHarness();
    const before = h.sent.length;
    const { feeAddr, feeSats, escrow } = await readyToFund(h);
    const opMsgs = h.to(OPERATOR, before);
    // operator only receives admin notices, no routine requests
    expect(opMsgs.every((m) => m.text.startsWith('🛎 Admin'))).toBe(true);
    expect(feeSats).toBe(10_000n);
    expect(feeAddr).toBe(feeAddress(parseFeeXpub(FEE_XPUB, NET), NET, 0));
    const dep = h.to(BUYER).find((m) => m.text.includes('Bereit zur Einzahlung'))!;
    expect(dep.text).toContain(escrow);
    expect(dep.text).toContain(feeAddr);
    expect(dep.buttons.find((b) => b.copy === '0.00010000')).toBeDefined();
  });

  it('the trade is only funded when the fee is confirmed too', async () => {
    const h = opHarness();
    const { tradeId, escrow, feeAddr, feeSats } = await readyToFund(h);
    h.chain.pay(escrow, 'c1'.repeat(32), 1_000_000n);
    h.chain.tip = 1001;
    h.chain.confirmAll(escrow, 1001);
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDING_SEEN');
    expect(h.last(BUYER).text).toMatch(/fehlt noch die Servicegebühr/);
    h.chain.received.set(feeAddr, { confirmedSats: feeSats - 1n, mempoolSats: 0n });
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDING_SEEN');
    h.chain.received.set(feeAddr, { confirmedSats: feeSats, mempoolSats: 0n });
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDED');
    expect(h.to(OPERATOR).some((m) => m.text.includes('Gebühr für Handel'))).toBe(true);
  });

  it('release: no commission output (fee already paid); buyer + seller sign; operator not bothered', async () => {
    const h = opHarness();
    const { tradeId, escrow, feeAddr, feeSats } = await readyToFund(h);
    await fund(h, escrow, feeAddr, feeSats);
    const opBefore = h.to(OPERATOR).length;
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const s = h.db.raw.prepare('SELECT outputs_json FROM psbt_sessions WHERE trade_id = ?').get(tradeId) as { outputs_json: string };
    expect(JSON.parse(s.outputs_json)).toHaveLength(1);
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

  it('dispute → operator decides refund and signs with the buyer', async () => {
    const h = opHarness();
    const { tradeId, escrow, feeAddr, feeSats } = await readyToFund(h);
    await fund(h, escrow, feeAddr, feeSats);
    await h.click(BUYER, `t:${tradeId}:dispute`);
    await h.text(BUYER, 'Rad hat Rahmenbruch');
    await h.text(BUYER, '-');
    expect(h.to(OPERATOR).some((m) => m.buttons.some((b) => b.data === `d:${tradeId}:take`))).toBe(true);
    await h.click(OPERATOR, `d:${tradeId}:take`);
    await h.click(OPERATOR, `d:${tradeId}:refund`);
    await h.text(OPERATOR, 'Mangel belegt');
    await h.click(BUYER, `t:${tradeId}:addr`);
    await h.text(BUYER, testAddress('buyer-refund'));
    const psbt = h.psbt(OPERATOR); // operator receives the PSBT after a dispute decision
    await h.click(BUYER, h.button(BUYER, /^s:.*:up$/));
    await h.text(BUYER, signAs(psbt, 'buyer'));
    await h.click(OPERATOR, h.button(OPERATOR, /^s:.*:up$/));
    await h.text(OPERATOR, signAsOperator(psbt));
    await h.click(OPERATOR, h.button(OPERATOR, /^s:.*:bc$/));
    expect((await h.trade(tradeId)).status).toBe('BROADCAST');
  });

  it('each trade gets its own fee address', async () => {
    const h = opHarness();
    const a = await readyToFund(h);
    const b = await readyToFund(h, 1);
    expect(a.feeAddr).not.toBe(b.feeAddr);
  });
});
