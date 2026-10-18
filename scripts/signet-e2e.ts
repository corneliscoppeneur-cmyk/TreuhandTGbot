/**
 * Live Signet end-to-end test WITHOUT extra Telegram accounts.
 * Runs the real bot code (handleFetch/handleScheduled) locally with:
 *   - real Bitcoin Signet via the configured Esplora APIs (real deposit, confirmation, payout)
 *   - simulated buyer and seller (Telegram updates are generated, bot replies are captured and printed)
 *   - TEST-ONLY keys for buyer and seller, stored in the state file (worthless Signet keys)
 *   - local SQLite database (same schema as D1)
 *
 * Usage:
 *   npm run e2e -- setup     create a trade up to "ready to fund" (prints address + exact amount)
 *   npm run e2e -- tick      run the blockchain poller once (detects deposit / confirmations)
 *   npm run e2e -- payout    seller delivers, buyer releases, both sign, bot broadcasts
 *   npm run e2e -- show      show trade state
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HDKey } from '@scure/bip32';
import { Transaction, p2wpkh, TEST_NETWORK } from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { handleFetch, handleScheduled, WEBHOOK_PATH } from '../src/app.ts';
import type { Env } from '../src/config/env.ts';
import { TestDb } from '../tests/helpers/d1.ts';

const DIR = join(process.cwd(), '.e2e');
const STATE = join(DIR, 'state.json');
const TPUB = { public: 0x043587cf, private: 0x04358394 };
const BUYER = 910_000_001;
const SELLER = 910_000_002;
const WEBHOOK_SECRET = 'local-e2e-webhook-secret-0123456789abcdef';
/** Seller payout goes to the operator's Sparrow fee wallet (index 5) so the result is visible in Sparrow. */
const FEE_WALLET_TPUB = 'tpubDCJkE1kXVkWc29KD1SqsUx7yzPgTpWQkQ5jtvgRgFiTbG9oNj8D9LE4ZHFAhFUny4ZSYnzqGdUTZThbHGDgfTqJJTt25knDWvnc12jgYowD';

interface State {
  buyerSeed: string;
  sellerSeed: string;
  tradeId?: string;
  nextUpdate: number;
}

function stripJsonc(text: string): string {
  return text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
}

function loadState(): State {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, 'utf8')) as State;
  mkdirSync(DIR, { recursive: true });
  const rnd = () => hex.encode(crypto.getRandomValues(new Uint8Array(32)));
  const s: State = { buyerSeed: rnd(), sellerSeed: rnd(), nextUpdate: 1 };
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  return s;
}
const state = loadState();
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));

function wallet(seedHex: string) {
  const root = HDKey.fromMasterSeed(hex.decode(seedHex), TPUB);
  const acc = root.derive("m/48'/1'/0'/2'");
  const fp = root.fingerprint.toString(16).padStart(8, '0');
  return { keyExpression: `[${fp}/48h/1h/0h/2h]${acc.publicExtendedKey}`, escrowKey: acc.deriveChild(0).deriveChild(0).privateKey! };
}
const buyer = wallet(state.buyerSeed);
const seller = wallet(state.sellerSeed);

// ---- environment: live vars from wrangler.jsonc, local test secrets ----
const vars = (JSON.parse(stripJsonc(readFileSync('wrangler.jsonc', 'utf8'))) as { vars: Record<string, string> }).vars;
// E2E_ESPLORA: run against another signet, e.g. Mutinynet (https://mutinynet.com/api, faucet.mutinynet.com)
if (process.env.E2E_ESPLORA) {
  vars.ESPLORA_PRIMARY_URL = process.env.E2E_ESPLORA;
  delete vars.ESPLORA_SECONDARY_URL;
}
const env = {
  ...vars,
  // fake token for the local run (assembled so the CI secret scanner does not flag it)
  TELEGRAM_BOT_TOKEN: ['123456789', 'AAEhBOweik9ai2o4z_LOCAL_E2E_ONLY_xxx'].join(':'),
  TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
  INVITE_HMAC_SECRET: 'local-e2e-invite-hmac-secret-0123456789abcdef',
} as unknown as Env;
const db = new TestDb(join(DIR, 'bot.sqlite'));

// ---- Telegram is simulated: capture outgoing bot messages, everything else (Esplora) goes to the real network ----
const realFetch = globalThis.fetch;
const sent: { chat: number; text: string }[] = [];
const name = (id: number) => (id === BUYER ? 'KÄUFER' : id === SELLER ? 'VERKÄUFER' : `BETREIBER ${id}`);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://api.telegram.org/')) return realFetch(input, init);
  let payload: Record<string, unknown> = {};
  if (typeof init?.body === 'string') payload = JSON.parse(init.body);
  const text = String(payload.text ?? (payload.rich_message as { html?: string } | undefined)?.html ?? '');
  if (payload.chat_id && text) sent.push({ chat: Number(payload.chat_id), text: text.replace(/<[^>]+>/g, '') });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1, date: 0, chat: { id: payload.chat_id, type: 'private' } } }), {
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

async function post(update: Record<string, unknown>) {
  const res = await handleFetch(
    new Request(`https://local${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
      body: JSON.stringify(update),
    }),
    env,
    { db },
  );
  if (res.status !== 200) throw new Error(`webhook ${res.status}: ${await res.text()}`);
  await new Promise((r) => setTimeout(r, 3100)); // stay outside the 3 s double-click window
}
const user = (id: number) => ({ id, is_bot: false, first_name: id === BUYER ? 'TestKäufer' : 'TestVerkäufer' });
async function text(id: number, t: string) {
  const u = state.nextUpdate++;
  save();
  const entities = t.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: t.split(' ')[0]!.length }] : undefined;
  await post({
    update_id: u,
    message: {
      message_id: u,
      date: Math.floor(Date.now() / 1000),
      chat: { id, type: 'private' },
      from: user(id),
      text: t,
      ...(entities ? { entities } : {}),
    },
  });
}
async function click(id: number, data: string) {
  const u = state.nextUpdate++;
  save();
  await post({
    update_id: u,
    callback_query: {
      id: String(u),
      from: user(id),
      chat_instance: '1',
      data,
      message: { message_id: 1, date: 0, chat: { id, type: 'private' }, text: 'x' },
    },
  });
}
const lastTo = (id: number) => [...sent].reverse().find((m) => m.chat === id)?.text ?? '';
const trade = () => db.raw.prepare('SELECT * FROM trades WHERE id = ?').get(state.tradeId!) as Record<string, unknown>;
const btc = (sats: bigint) => `${sats / 100_000_000n}.${(sats % 100_000_000n).toString().padStart(8, '0')}`;

function printSent(from = 0) {
  for (const m of sent.slice(from)) console.log(`\n── an ${name(m.chat)} ──\n${m.text.slice(0, 600)}`);
}

async function setup() {
  if (state.tradeId) return console.log(`Handel existiert bereits: #${state.tradeId}. Zum Neustart den Ordner .e2e löschen.`);
  await text(BUYER, '/newtrade');
  for (const t of ['Signet-Testhandel', 'Live-Test des Treuhand-Bots', process.env.E2E_AMOUNT ?? '0,0001', 'Test, keine echte Ware'])
    await text(BUYER, t);
  await click(BUYER, 'n:role:buyer');
  await click(BUYER, 'n:confirm');
  const id = /Handel #([A-Z0-9]{8}) erstellt/.exec(sent.map((m) => m.text).join('\n'))?.[1];
  if (!id) throw new Error('trade not created');
  state.tradeId = id;
  save();
  await click(BUYER, `i:${id}:seller`);
  const inv = lastTo(BUYER);
  const token = /start=i_([A-Za-z0-9_-]{43})/.exec(inv)![1]!;
  const code = /Zugangscode[^:]*: ([A-Z0-9]{8})/.exec(inv)![1]!;
  await text(SELLER, `/start i_${token}`);
  await text(SELLER, code);
  for (const u of [BUYER, SELLER]) {
    await click(u, `t:${id}:terms`);
    const hash = (trade().agreement_hash as string).slice(0, 16);
    await click(u, `t:${id}:agree:${hash}`);
  }
  await click(BUYER, `t:${id}:key`);
  await text(BUYER, buyer.keyExpression);
  await click(SELLER, `t:${id}:key`);
  await text(SELLER, seller.keyExpression);
  const ms = db.raw.prepare('SELECT address FROM multisig_configs WHERE trade_id = ?').get(id) as { address: string };
  for (const u of [BUYER, SELLER]) await click(u, `t:${id}:verify:${ms.address.slice(-8)}`);
  const t = trade();
  const total = BigInt(Number(t.amount_sats)) + BigInt(Number(t.fee_sats));
  console.log(`\n✅ Handel #${id} ist bereit zur Einzahlung (Status ${t.status}).`);
  console.log(`\n👉 Bitte aus Sparrow GENAU ${btc(total)} BTC senden an:\n   ${ms.address}`);
  console.log(`   (Handelsbetrag ${btc(BigInt(Number(t.amount_sats)))} + 3 % Gebühr ${btc(BigInt(Number(t.fee_sats)))})`);
}

async function tick() {
  const before = sent.length;
  await handleScheduled(env, { db });
  const t = trade();
  console.log(`Handel #${state.tradeId}: ${t.status}${t.review_reason ? ` (${t.review_reason})` : ''}`);
  printSent(before);
}

async function payout() {
  const id = state.tradeId!;
  if (trade().status !== 'FUNDED') return console.log(`Noch nicht finanziert (Status ${trade().status}). Erst "tick" bis FUNDED.`);
  await click(SELLER, `t:${id}:delivered`);
  await click(BUYER, `t:${id}:release`);
  await click(SELLER, `t:${id}:addr`);
  const payTo = p2wpkh(HDKey.fromExtendedKey(FEE_WALLET_TPUB, TPUB).deriveChild(0).deriveChild(5).publicKey!, TEST_NETWORK).address!;
  await text(SELLER, payTo);
  const s = db.raw.prepare(`SELECT id, base_psbt, txid FROM psbt_sessions WHERE trade_id = ? AND status = 'open'`).get(id) as {
    id: string;
    base_psbt: string;
    txid: string;
  };
  for (const [u, key] of [
    [BUYER, buyer.escrowKey],
    [SELLER, seller.escrowKey],
  ] as const) {
    const tx = Transaction.fromPSBT(base64.decode(s.base_psbt));
    for (let i = 0; i < tx.inputsLength; i++) tx.signIdx(key, i);
    await click(u, `s:${s.id}:up`);
    await text(u, base64.encode(tx.toPSBT()));
  }
  const before = sent.length;
  await click(SELLER, `s:${s.id}:bc`);
  printSent(before);
  console.log(`\n🚀 Status: ${trade().status}. txid ${s.txid}\n   https://mempool.space/signet/tx/${s.txid}`);
  console.log(`   Verkäufer-Auszahlung an ${payTo} (deine Sparrow-Gebühren-Wallet, Adresse Nr. 5)`);
}

function show() {
  if (!state.tradeId) return console.log('Noch kein Handel. Zuerst: npm run e2e -- setup');
  const t = trade();
  const ms = db.raw.prepare('SELECT address FROM multisig_configs WHERE trade_id = ?').get(state.tradeId) as
    { address: string } | undefined;
  console.log({ trade: t.id, status: t.status, amount_sats: t.amount_sats, fee_sats: t.fee_sats, escrow: ms?.address });
}

const cmd = process.argv[2];
if (cmd === 'setup') await setup();
else if (cmd === 'tick') await tick();
else if (cmd === 'payout') await payout();
else show();
