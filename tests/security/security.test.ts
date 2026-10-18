import { afterEach, describe, expect, it, vi } from 'vitest';
import { Harness, testEnv, WEBHOOK_SECRET } from '../helpers/harness.ts';
import { inviteAndJoin, setupFundedTrade } from '../helpers/flows.ts';
import { ConfigError, MAINNET_RELEASE_PHRASE, parseConfig } from '../../src/config/env.ts';
import { can, ROLES } from '../../src/domain/permissions.ts';
import { assertTransition, canTransition, TERMINAL_STATES, TRADE_STATES } from '../../src/domain/state-machine.ts';
import { redact, looksLikeMnemonic } from '../../src/security/redaction.ts';
import { parseBtcAmount, formatBtc } from '../../src/domain/amount.ts';
import { testAddress, wallets } from '../helpers/escrow.ts';

const BUYER = 1001;
const SELLER = 1002;
const ARBITER = 1003;
const OBSERVER = 1004;
const STRANGER = 6666;

afterEach(() => vi.unstubAllGlobals());

async function newTrade(h: Harness): Promise<string> {
  await h.text(BUYER, '/newtrade');
  await h.text(BUYER, 'T');
  await h.text(BUYER, 'D');
  await h.text(BUYER, '0,001');
  await h.text(BUYER, 'B');
  await h.click(BUYER, 'n:role:buyer');
  await h.click(BUYER, 'n:confirm');
  return /Handel #([A-Z0-9]{8}) erstellt/.exec(h.last(BUYER).text)![1]!;
}

describe('configuration', () => {
  const raw = () => testEnv() as unknown as Record<string, unknown>;
  it('accepts a valid signet config', () => {
    expect(parseConfig(raw()).network).toBe('signet');
  });
  it('rejects missing/invalid values', () => {
    expect(() => parseConfig({ ...raw(), TELEGRAM_WEBHOOK_SECRET: 'short' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...raw(), DEFAULT_COMMISSION_BPS: '1.5' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...raw(), SUPPORT_BOT_URL: 'http://t.me/x' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...raw(), BITCOIN_NETWORK: 'testnet' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...raw(), TELEGRAM_BOT_TOKEN: undefined })).toThrow(ConfigError);
  });
  it('custodial mode can never be enabled', () => {
    expect(() => parseConfig({ ...raw(), ENABLE_CUSTODIAL_FEATURES: 'true' })).toThrow(/custodial/);
  });
  it('mainnet needs BITCOIN_NETWORK, ALLOW_MAINNET and the release phrase together', () => {
    expect(() => parseConfig({ ...raw(), BITCOIN_NETWORK: 'mainnet' })).toThrow(/locked/);
    expect(() => parseConfig({ ...raw(), BITCOIN_NETWORK: 'mainnet', ALLOW_MAINNET: 'true' })).toThrow(/locked/);
    expect(
      parseConfig({ ...raw(), BITCOIN_NETWORK: 'mainnet', ALLOW_MAINNET: 'true', MAINNET_RELEASE_CONFIRMATION: MAINNET_RELEASE_PHRASE })
        .network,
    ).toBe('mainnet');
  });
  it('invalid config fails closed with 503', async () => {
    const h = new Harness({ ENABLE_CUSTODIAL_FEATURES: 'true' });
    const r = await h.text(BUYER, '/start');
    expect(r.status).toBe(503);
    expect(h.sent).toHaveLength(0);
  });
  it('commission address must match the network', async () => {
    const h = new Harness({ COMMISSION_ADDRESS: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' });
    expect((await h.text(BUYER, '/start')).status).toBe(503);
  });
});

describe('webhook', () => {
  it('rejects a wrong or missing secret with 401', async () => {
    const h = new Harness();
    const upd = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 1, type: 'private' },
        from: { id: 1, is_bot: false, first_name: 'x' },
        text: '/start',
      },
    };
    expect((await h.post(upd, 'wrong')).status).toBe(401);
    expect((await h.post(upd, '')).status).toBe(401);
    expect(h.sent).toHaveLength(0);
    expect((await h.post(upd, WEBHOOK_SECRET)).status).toBe(200);
  });
  it('rejects invalid updates', async () => {
    const h = new Harness();
    expect((await h.post({ foo: 1 })).status).toBe(400);
  });
  it('processes a duplicate update only once', async () => {
    const h = new Harness();
    const upd = {
      update_id: 77,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: BUYER, type: 'private' },
        from: { id: BUYER, is_bot: false, first_name: 'x' },
        text: '/start',
      },
    };
    await h.post(upd);
    await h.post(upd);
    expect(h.to(BUYER)).toHaveLength(1);
  });
  it('a D1 outage causes 500 (Telegram retries) and changes nothing', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    const before = await h.trade(id);
    h.db.failing = true;
    const r = await h.click(BUYER, `t:${id}:cancelok`);
    expect(r.status).toBe(500);
    h.db.failing = false;
    expect((await h.trade(id)).version).toBe(before.version);
  });
});

describe('permissions and roles', () => {
  it('observers and mediators can never sign or decide', () => {
    for (const r of ['observer', 'mediator'] as const) {
      expect(can(r, 'sign_psbt')).toBe(false);
      expect(can(r, 'register_key')).toBe(false);
      expect(can(r, 'request_release')).toBe(false);
      expect(can(r, 'decide_dispute')).toBe(false);
      expect(can(r, 'view_payment_details')).toBe(false);
    }
    expect(can('buyer', 'decide_dispute')).toBe(false);
    expect(can('seller', 'request_release')).toBe(false);
    expect(ROLES).toHaveLength(5);
  });

  it('strangers cannot see or act on a trade (manipulated callback data)', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    for (const action of ['view', 'pay', 'inv', 'cancelok', 'release', 'key']) {
      await h.click(STRANGER, `t:${id}:${action}`);
      expect(h.last(STRANGER).text).toMatch(/nicht gefunden/);
    }
    await h.click(STRANGER, `i:${id}:arbiter`);
    expect(h.last(STRANGER).text).not.toMatch(/start=i_/);
    expect((await h.trade(id)).status).toBe('INVITING');
  });

  it('an observer cannot register keys, release or upload signatures', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await inviteAndJoin(h, tradeId, 'observer', OBSERVER);
    await h.click(OBSERVER, `t:${tradeId}:release`);
    expect(h.last(OBSERVER).text).toMatch(/Berechtigung/);
    await h.click(OBSERVER, `t:${tradeId}:pay`);
    expect(h.last(OBSERVER).text).not.toMatch(/tb1q/);
    expect((await h.trade(tradeId)).status).toBe('FUNDED');
  });

  it('one person cannot hold two roles in a trade', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.click(BUYER, `i:${id}:seller`);
    const msg = h.last(BUYER).text;
    const token = /start=i_([A-Za-z0-9_-]{43})/.exec(msg)![1]!;
    const code = /Zugangscode: ([A-Z0-9]{8})/.exec(msg)![1]!;
    await h.text(BUYER, `/start i_${token}`);
    await h.text(BUYER, code);
    expect(h.last(BUYER).text).toMatch(/nur eine Rolle/);
  });

  it('the same wallet (fingerprint) cannot be used for two roles', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await inviteAndJoin(h, id, 'seller', SELLER);
    await inviteAndJoin(h, id, 'arbiter', ARBITER);
    for (const u of [BUYER, SELLER, ARBITER]) {
      await h.click(u, `t:${id}:terms`);
      await h.click(u, h.button(u, /:agree:/));
    }
    await h.click(BUYER, `t:${id}:key`);
    await h.text(BUYER, wallets.buyer.keyExpression);
    // seller submits a different account of the buyer's wallet
    const { testWallet } = await import('../helpers/keys.ts');
    await h.click(SELLER, `t:${id}:key`);
    await h.text(SELLER, testWallet('buyer', 7).keyExpression);
    expect(h.last(SELLER).text).toMatch(/Fingerprint/);
  });

  it('private keys and seeds are refused and never stored', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await inviteAndJoin(h, id, 'seller', SELLER);
    await inviteAndJoin(h, id, 'arbiter', ARBITER);
    for (const u of [BUYER, SELLER, ARBITER]) {
      await h.click(u, `t:${id}:terms`);
      await h.click(u, h.button(u, /:agree:/));
    }
    await h.click(BUYER, `t:${id}:key`);
    await h.text(BUYER, wallets.buyer.account.privateExtendedKey);
    expect(h.last(BUYER).text).toMatch(/PRIVATER Schlüssel/);
    await h.click(BUYER, `t:${id}:key`);
    await h.text(BUYER, 'abandon ability able about above absent absorb abstract absurd abuse access accident');
    expect(h.last(BUYER).text).toMatch(/PRIVATER Schlüssel|Seed/);
    const rows = h.db.raw.prepare('SELECT COUNT(*) AS n FROM signers_public').get() as { n: number };
    expect(rows.n).toBe(0);
    const dump = JSON.stringify(h.db.raw.prepare('SELECT * FROM audit_events').all());
    expect(dump).not.toMatch(/tprv/);
  });
});

describe('invites and access codes', () => {
  it('invites expire', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.click(BUYER, `i:${id}:seller`);
    const token = /start=i_([A-Za-z0-9_-]{43})/.exec(h.last(BUYER).text)![1]!;
    h.clock += 73 * 3600;
    await h.text(SELLER, `/start i_${token}`);
    expect(h.last(SELLER).text).toMatch(/abgelaufen/);
  });

  it('tokens are single-use and bound to the first account', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    const { token, code } = await inviteAndJoin(h, id, 'seller', SELLER);
    await h.text(STRANGER, `/start i_${token}`);
    expect(h.last(STRANGER).text).toMatch(/ungültig|verwendet|anderes Konto/);
    await h.text(STRANGER, code);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM participants WHERE telegram_user_id = ?').get(STRANGER)).toEqual({ n: 0 });
  });

  it('a leaked link cannot be used by a second account after the first opened it', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.click(BUYER, `i:${id}:seller`);
    const token = /start=i_([A-Za-z0-9_-]{43})/.exec(h.last(BUYER).text)![1]!;
    await h.text(SELLER, `/start i_${token}`);
    await h.text(STRANGER, `/start i_${token}`);
    expect(h.last(STRANGER).text).toMatch(/anderes Konto/);
  });

  it('wrong codes are rate limited and lock the invite after 5 attempts', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.click(BUYER, `i:${id}:seller`);
    const msg = h.last(BUYER).text;
    const token = /start=i_([A-Za-z0-9_-]{43})/.exec(msg)![1]!;
    const code = /Zugangscode: ([A-Z0-9]{8})/.exec(msg)![1]!;
    await h.text(SELLER, `/start i_${token}`);
    for (let i = 0; i < 5; i++) await h.text(SELLER, 'WRONG123');
    expect(h.last(SELLER).text).toMatch(/gesperrt/);
    await h.text(SELLER, `/start i_${token}`);
    await h.text(SELLER, code);
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM participants WHERE telegram_user_id = ?').get(SELLER)).toEqual({ n: 0 });
  });

  it('stores only HMAC digests of tokens and codes', async () => {
    const h = new Harness();
    const id = await newTrade(h);
    await h.click(BUYER, `i:${id}:seller`);
    const msg = h.last(BUYER).text;
    const token = /start=i_([A-Za-z0-9_-]{43})/.exec(msg)![1]!;
    const code = /Zugangscode: ([A-Z0-9]{8})/.exec(msg)![1]!;
    const dump = JSON.stringify(h.db.raw.prepare('SELECT * FROM invites').all());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(code);
  });
});

describe('privacy in group chats', () => {
  it('group notices never contain addresses, keys or PSBTs', async () => {
    const h = new Harness();
    const GROUP = -100123;
    const { tradeId } = await setupFundedTrade(h);
    await h.text(BUYER, `/link ${tradeId}`, { id: GROUP, type: 'supergroup' });
    await h.click(SELLER, `t:${tradeId}:delivered`);
    await h.click(BUYER, `t:${tradeId}:release`);
    await h.click(SELLER, `t:${tradeId}:addr`);
    await h.text(SELLER, testAddress('seller-payout'));
    const groupMsgs = h.to(GROUP);
    expect(groupMsgs.length).toBeGreaterThan(0);
    for (const m of groupMsgs.slice(1)) {
      expect(m.text).not.toMatch(/tb1|tpub|cHNidP8|Zugangscode|start=i_/);
      expect(m.document).toBe(false);
    }
  });

  it('commands in groups other than /link and /status are refused', async () => {
    const h = new Harness();
    await h.text(BUYER, '/newtrade', { id: -5, type: 'group' });
    expect(h.last(-5).text).toMatch(/privaten Chat/);
  });
});

describe('state machine', () => {
  it('terminal states have no exits', () => {
    for (const s of TERMINAL_STATES) for (const t of TRADE_STATES) expect(canTransition(s, t)).toBe(false);
  });
  it('rejects forbidden transitions', () => {
    expect(() => assertTransition('READY_TO_FUND', 'COMPLETE')).toThrow();
    expect(() => assertTransition('DISPUTED', 'SIGNING')).toThrow();
    expect(() => assertTransition('FUNDED', 'CANCELLED')).toThrow();
    expect(() => assertTransition('INVITING', 'FUNDED')).toThrow();
  });
  it('funded trades cannot be cancelled via callback', async () => {
    const h = new Harness();
    const { tradeId } = await setupFundedTrade(h);
    await h.click(BUYER, `t:${tradeId}:cancelok`);
    expect((await h.trade(tradeId)).status).toBe('FUNDED');
  });
});

describe('amounts and redaction', () => {
  it('parses BTC amounts exactly without floating point', () => {
    expect(parseBtcAmount('0,01')).toBe(1_000_000n);
    expect(parseBtcAmount('0.00012345')).toBe(12_345n);
    expect(parseBtcAmount('1000000 sat')).toBe(1_000_000n);
    expect(formatBtc(123_456_789n)).toBe('1,23456789');
    expect(() => parseBtcAmount('0.000000001')).toThrow();
    expect(() => parseBtcAmount('1e5')).toThrow();
    expect(() => parseBtcAmount('-1')).toThrow();
    expect(() => parseBtcAmount('21000001')).toThrow();
  });
  it('redacts secrets from logs', () => {
    const s = redact(
      `token 123456789:AAEhBOweik9ai2o4z_TEST_ONLY_TOKEN_x key ${wallets.buyer.account.privateExtendedKey} addr ${testAddress('x')}`,
    );
    expect(s).not.toMatch(/AAEh|tprv|tb1q/);
    expect(looksLikeMnemonic('abandon ability able about above absent absorb abstract absurd abuse access accident')).toBe(true);
  });
});
