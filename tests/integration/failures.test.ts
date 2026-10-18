import { afterEach, describe, expect, it, vi } from 'vitest';
import { Harness } from '../helpers/harness.ts';
import { ARBITER, BUYER, IDS, SELLER, inviteAndJoin, setupFundedTrade } from '../helpers/flows.ts';
import { signAs, testAddress, wallets } from '../helpers/escrow.ts';
import { EsploraProvider } from '../../src/blockchain/esplora.ts';
import { CrossCheckedProvider } from '../../src/blockchain/fallback.ts';
import { ProviderError } from '../../src/blockchain/provider.ts';
import { evaluateFunding } from '../../src/bitcoin/funding.ts';

afterEach(() => vi.unstubAllGlobals());

/** Drives a trade to READY_TO_FUND and returns its escrow address. */
async function readyToFund(h: Harness): Promise<{ tradeId: string; address: string }> {
  await h.text(BUYER, '/newtrade');
  for (const t of ['T', 'D', '0,01', 'B']) await h.text(BUYER, t);
  await h.click(BUYER, 'n:role:buyer');
  await h.click(BUYER, 'n:confirm');
  const tradeId = /Handel #([A-Z0-9]{8}) erstellt/.exec(h.last(BUYER).text)![1]!;
  await inviteAndJoin(h, tradeId, 'seller', SELLER);
  await inviteAndJoin(h, tradeId, 'arbiter', ARBITER);
  for (const id of [BUYER, SELLER, ARBITER]) {
    await h.click(id, `t:${tradeId}:terms`);
    await h.click(id, h.button(id, /:agree:/));
  }
  for (const role of ['buyer', 'seller', 'arbiter'] as const) {
    await h.click(IDS[role], `t:${tradeId}:key`);
    await h.text(IDS[role], wallets[role].keyExpression);
  }
  for (const id of [BUYER, SELLER, ARBITER]) await h.click(id, h.button(id, /:verify:/));
  const address = /\n(tb1q[0-9a-z]{58})\n/.exec(h.last(BUYER).text)![1]!;
  expect((await h.trade(tradeId)).status).toBe('READY_TO_FUND');
  return { tradeId, address };
}

describe('funding policy', () => {
  it('unconfirmed funding is never final', async () => {
    const h = new Harness();
    const { tradeId, address } = await readyToFund(h);
    h.chain.pay(address, 'c1'.repeat(32), 1_000_000n);
    for (let i = 0; i < 3; i++) await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDING_SEEN');
  });

  it('partial payment waits; topping up to the exact amount funds the trade', async () => {
    const h = new Harness();
    const { tradeId, address } = await readyToFund(h);
    h.chain.pay(address, 'c1'.repeat(32), 400_000n);
    h.chain.tip = 1001;
    h.chain.confirmAll(address, 1001);
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDING_SEEN');
    expect(h.last(BUYER).text).toMatch(/Teilzahlung/);
    h.chain.pay(address, 'c2'.repeat(32), 600_000n);
    h.chain.tip = 1002;
    h.chain.confirmAll(address, 1002);
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDED');
  });

  it('overpayment stops in NEEDS_REVIEW (no automatic refund)', async () => {
    const h = new Harness();
    const { tradeId, address } = await readyToFund(h);
    h.chain.pay(address, 'c1'.repeat(32), 1_500_000n);
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('NEEDS_REVIEW');
    expect(h.chain.broadcasts).toHaveLength(0);
  });

  it('a vanished unconfirmed payment returns to READY_TO_FUND', async () => {
    const h = new Harness();
    const { tradeId, address } = await readyToFund(h);
    h.chain.pay(address, 'c1'.repeat(32), 1_000_000n);
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('FUNDING_SEEN');
    h.chain.utxos.set(address, []);
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('READY_TO_FUND');
  });

  it('evaluateFunding handles all verdicts', () => {
    const u = (v: bigint, h: number | null) => ({
      txid: 'a'.repeat(64),
      vout: 0,
      valueSats: v,
      confirmed: h !== null,
      blockHeight: h,
      blockHash: h ? 'b'.repeat(64) : null,
    });
    expect(evaluateFunding(100n, [], 10, 1).verdict).toBe('none');
    expect(evaluateFunding(100n, [u(50n, 10)], 10, 1).verdict).toBe('partial');
    expect(evaluateFunding(100n, [u(100n, null)], 10, 1).verdict).toBe('pending');
    expect(evaluateFunding(100n, [u(100n, 10)], 10, 2).verdict).toBe('pending');
    expect(evaluateFunding(100n, [u(100n, 9)], 10, 2).verdict).toBe('funded');
    expect(evaluateFunding(100n, [u(101n, 9)], 10, 2).verdict).toBe('overpaid');
  });
});

describe('chain anomalies after funding', () => {
  it('reorg of the confirmed funding → NEEDS_REVIEW', async () => {
    const h = new Harness();
    const { tradeId, address } = await setupFundedTrade(h);
    const u = h.chain.utxos.get(address)![0]!;
    u.blockHash = 'ff'.repeat(32); // same output, different block
    await h.cron(3600);
    expect((await h.trade(tradeId)).status).toBe('NEEDS_REVIEW');
  });

  it('funds spent outside the bot → NEEDS_REVIEW', async () => {
    const h = new Harness();
    const { tradeId, address } = await setupFundedTrade(h);
    h.chain.utxos.set(address, []);
    h.chain.outspends.set(`${'cc'.repeat(32)}:0`, { spent: true, spendingTxid: '99'.repeat(32) });
    await h.cron(3600);
    const t = await h.trade(tradeId);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(String(t.review_reason)).toMatch(/außerhalb/);
  });

  it('our exact transaction broadcast by a signer wallet is followed to COMPLETE', async () => {
    const h = new Harness();
    const { tradeId, address } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const s = h.db.raw.prepare('SELECT txid FROM psbt_sessions WHERE trade_id = ?').get(tradeId) as { txid: string };
    h.chain.utxos.set(address, []);
    h.chain.outspends.set(`${'cc'.repeat(32)}:0`, { spent: true, spendingTxid: s.txid });
    await h.cron(3600);
    expect((await h.trade(tradeId)).status).toBe('BROADCAST');
    h.chain.tip = 1010;
    h.chain.txStatus.set(s.txid, { confirmed: true, blockHeight: 1010, blockHash: '12'.repeat(32) });
    await h.cron(600);
    expect((await h.trade(tradeId)).status).toBe('COMPLETE');
  });

  it('blockchain API outage: no state change, backoff recorded', async () => {
    const h = new Harness();
    const { tradeId, address } = await readyToFund(h);
    h.chain.pay(address, 'c1'.repeat(32), 1_000_000n);
    h.chain.failing = true;
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('READY_TO_FUND');
    h.chain.failing = false;
    h.chain.tip = 1001;
    h.chain.confirmAll(address, 1001);
    await h.cron(3600);
    expect((await h.trade(tradeId)).status).toBe('FUNDED');
  });

  it('broadcast rejected by the network → NEEDS_REVIEW, session failed', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const psbt = [...h.to(BUYER)]
      .reverse()
      .find((m) => m.text.includes('PSBT:\n'))!
      .text.split('PSBT:\n')[1]!
      .trim();
    for (const [id, role] of [
      [BUYER, 'buyer'],
      [SELLER, 'seller'],
    ] as const) {
      await h.click(id, h.button(id, /^s:.*:up$/));
      await h.text(id, signAs(psbt, role));
    }
    h.chain.rejectBroadcast = true;
    await h.click(SELLER, h.button(SELLER, /^s:.*:bc$/));
    expect((await h.trade(tradeId)).status).toBe('NEEDS_REVIEW');
    const s = h.db.raw.prepare('SELECT status FROM psbt_sessions WHERE trade_id = ?').get(tradeId) as { status: string };
    expect(s.status).toBe('failed');
  });

  it('fee rate above maximum: no PSBT is created', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:release`);
    h.chain.feeRate = 500;
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    expect(h.last(SELLER).text).toMatch(/Maximum/);
    expect((await h.trade(tradeId)).status).toBe('RELEASE_REQUESTED');
  });

  it('payout address of the wrong network is refused', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq');
    expect(h.last(SELLER).text).toMatch(/Netzwerk/);
  });

  it('Telegram API outage while notifying does not break the state change', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    h.apiFailing = true;
    const r = await h.click(SELLER, `t:${tradeId}:delivered`);
    expect(r.status).toBe(200);
    expect((await h.trade(tradeId)).status).toBe('FULFILLMENT');
  });
});

describe('Esplora provider', () => {
  const res = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('validates responses strictly', async () => {
    const p = new EsploraProvider({
      baseUrl: 'https://x.test/api',
      name: 'p',
      fetchFn: async () => res([{ txid: 'zz', vout: 0, value: 1, status: { confirmed: false } }]),
    });
    await expect(p.getAddressUtxos('tb1q')).rejects.toMatchObject({ kind: 'invalid_response' });
    const q = new EsploraProvider({
      baseUrl: 'https://x.test/api',
      name: 'q',
      fetchFn: async () => res([{ txid: 'a'.repeat(64), vout: 0, value: 1.5, status: { confirmed: false } }]),
    });
    await expect(q.getAddressUtxos('tb1q')).rejects.toBeInstanceOf(ProviderError);
  });

  it('retries a bounded number of times on 5xx / 429 and then fails', async () => {
    let calls = 0;
    const p = new EsploraProvider({
      baseUrl: 'https://x.test',
      name: 'p',
      maxRetries: 2,
      sleep: async () => undefined,
      fetchFn: async () => {
        calls++;
        return res('busy', 503);
      },
    });
    await expect(p.getTipHeight()).rejects.toMatchObject({ kind: 'http' });
    expect(calls).toBe(3);
    const r = new EsploraProvider({
      baseUrl: 'https://x.test',
      name: 'r',
      maxRetries: 1,
      sleep: async () => undefined,
      fetchFn: async () => res('slow down', 429),
    });
    await expect(r.getTipHeight()).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('times out slow APIs', async () => {
    const p = new EsploraProvider({
      baseUrl: 'https://x.test',
      name: 'p',
      timeoutMs: 20,
      maxRetries: 0,
      fetchFn: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    await expect(p.getTipHeight()).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('404 tx status means unknown, broadcast 400 means rejected', async () => {
    const p = new EsploraProvider({
      baseUrl: 'https://x.test',
      name: 'p',
      fetchFn: async (u) => (u.endsWith('/tx') ? res('bad-txns', 400) : res('not found', 404)),
    });
    expect(await p.getTxStatus('a'.repeat(64))).toBeNull();
    await expect(p.broadcast('00')).rejects.toMatchObject({ kind: 'rejected' });
  });

  it('cross-check raises disagreement on conflicting confirmed UTXOs', async () => {
    const mk = (value: number) =>
      new EsploraProvider({
        baseUrl: 'https://x.test',
        name: `v${value}`,
        fetchFn: async () =>
          res([{ txid: 'a'.repeat(64), vout: 0, value, status: { confirmed: true, block_height: 5, block_hash: 'b'.repeat(64) } }]),
      });
    const c = new CrossCheckedProvider(mk(100), mk(200));
    await expect(c.getAddressUtxos('tb1q')).rejects.toMatchObject({ kind: 'disagreement' });
    const ok = new CrossCheckedProvider(mk(100), mk(100));
    expect(await ok.getAddressUtxos('tb1q')).toHaveLength(1);
  });

  it('provider disagreement during polling moves the trade to NEEDS_REVIEW', async () => {
    const h = new Harness();
    const { tradeId, address } = await readyToFund(h);
    h.chain.pay(address, 'c1'.repeat(32), 1_000_000n);
    h.chain.getAddressUtxos = async () => {
      throw new ProviderError('disagreement', 'providers disagree');
    };
    await h.cron();
    expect((await h.trade(tradeId)).status).toBe('NEEDS_REVIEW');
  });
});
