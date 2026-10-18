/**
 * TEST-ONLY harness: drives the real Worker entry (handleFetch/handleScheduled) with fake Telegram
 * updates, a node:sqlite D1 stand-in, a controllable clock and a fake blockchain provider.
 * Outgoing Telegram API calls are captured instead of being sent.
 */
import { vi } from 'vitest';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import type { BlockchainProvider, ChainUtxo, Outspend, TxStatus } from '../../src/blockchain/provider.ts';
import { ProviderError } from '../../src/blockchain/provider.ts';
import type { Env } from '../../src/config/env.ts';
import { handleFetch, handleScheduled, WEBHOOK_PATH } from '../../src/app.ts';
import { TestDb } from './d1.ts';
import { testAddress } from './escrow.ts';
import { toPlain } from '../../src/telegram/format.ts';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';

export function testEnv(over: Partial<Record<keyof Env, string>> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    TELEGRAM_BOT_TOKEN: '123456789:AAEhBOweik9ai2o4z_TEST_ONLY_TOKEN_x',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    INVITE_HMAC_SECRET: 'test-invite-hmac-secret-0123456789abcdef',
    TELEGRAM_BOT_USERNAME: 'TestTreuhandBot',
    BITCOIN_NETWORK: 'signet',
    ALLOW_MAINNET: 'false',
    SUPPORT_BOT_URL: 'https://t.me/GruppennetzwerkKontakt_bot',
    CRYPTGEON_URL: 'https://cryptgeon.org',
    DEFAULT_COMMISSION_BPS: '100',
    REFUND_COMMISSION_BPS: '0',
    COMMISSION_ADDRESS: testAddress('operator'),
    MIN_CONFIRMATIONS_SIGNET: '1',
    MIN_CONFIRMATIONS_MAINNET: '3',
    BLOCKCHAIN_PROVIDER: 'esplora',
    ESPLORA_PRIMARY_URL: 'https://example.invalid/signet/api',
    MAX_FEE_RATE_SAT_VB: '50',
    MAX_FEE_PERCENT: '5',
    POLL_MAX_TRADES_PER_RUN: '5',
    ENABLE_AUTOMATIC_BROADCAST: 'false',
    ENABLE_CUSTODIAL_FEATURES: 'false',
    ADMIN_TELEGRAM_IDS: '9999',
    DATA_RETENTION_DAYS: '90',
    ...over,
  } as Env;
}

export class FakeChain implements BlockchainProvider {
  name = 'fake';
  tip = 1000;
  utxos = new Map<string, ChainUtxo[]>();
  txStatus = new Map<string, TxStatus>();
  outspends = new Map<string, Outspend>();
  broadcasts: string[] = [];
  feeRate = 2;
  failing = false;
  rejectBroadcast = false;

  private check() {
    if (this.failing) throw new ProviderError('timeout', 'simulated outage', this.name);
  }
  async getTipHeight() {
    this.check();
    return this.tip;
  }
  async getAddressUtxos(address: string) {
    this.check();
    return this.utxos.get(address) ?? [];
  }
  async getTxStatus(txid: string) {
    this.check();
    return this.txStatus.get(txid) ?? null;
  }
  async getOutspend(txid: string, vout: number) {
    this.check();
    return this.outspends.get(`${txid}:${vout}`) ?? { spent: false, spendingTxid: null };
  }
  async isBlockInBestChain() {
    return true;
  }
  async getFeeEstimates() {
    this.check();
    return { '1': this.feeRate + 1, '6': this.feeRate, '144': 1 };
  }
  async broadcast(raw: string) {
    this.check();
    if (this.rejectBroadcast) throw new ProviderError('rejected', 'bad-txns-inputs-missingorspent', this.name);
    this.broadcasts.push(raw);
    return Transaction.fromRaw(hex.decode(raw)).id;
  }
  /** Simulates a payment to the escrow address. */
  pay(address: string, txid: string, value: bigint, confirmedAt: number | null = null) {
    const list = this.utxos.get(address) ?? [];
    list.push({
      txid,
      vout: 0,
      valueSats: value,
      confirmed: confirmedAt !== null,
      blockHeight: confirmedAt,
      blockHash: confirmedAt ? 'bb'.repeat(32) : null,
    });
    this.utxos.set(address, list);
  }
  confirmAll(address: string, height: number) {
    for (const u of this.utxos.get(address) ?? []) {
      u.confirmed = true;
      u.blockHeight = height;
      u.blockHash = height.toString(16).padStart(64, '0');
    }
  }
}

export interface SentButton {
  text: string;
  data?: string;
  url?: string;
  copy?: string;
  style?: string;
  disabled?: boolean;
}

export interface SentMessage {
  method: string;
  chatId: number;
  /** Plain text (markup stripped) – what the user reads. */
  text: string;
  /** Raw markup as sent (HTML or rich HTML). */
  raw: string;
  parseMode?: string;
  buttons: SentButton[];
  document?: boolean;
  protect?: boolean;
  ephemeralFor?: number;
  forceReply?: boolean;
}

export class Harness {
  db = new TestDb();
  chain = new FakeChain();
  clock = 1_800_000_000;
  sent: SentMessage[] = [];
  private updateId = 1;
  env: Env;
  apiFailing = false;
  /** Simulate clients/servers without sendRichMessage support. */
  richUnsupported = false;
  /** Simulate chats where ephemeral messages are not available. */
  ephemeralUnsupported = false;

  constructor(envOver: Partial<Record<keyof Env, string>> = {}) {
    this.env = testEnv(envOver);
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.telegram.org/')) throw new Error(`unexpected fetch ${url}`);
      if (this.apiFailing) throw new Error('telegram down');
      const method = url.split('/').pop()!;
      let payload: Record<string, unknown> = {};
      const body = init?.body;
      if (typeof body === 'string') payload = JSON.parse(body);
      else if (body instanceof FormData || (body && typeof (body as { get?: unknown }).get === 'function'))
        payload = { chat_id: Number((body as FormData).get('chat_id')) };
      else if (body) {
        // grammY streams multipart for InputFile; read chat_id from the text
        const text = await new Response(body as BodyInit).text();
        const m = /name="chat_id"\r\n\r\n(-?\d+)/.exec(text);
        payload = { chat_id: m ? Number(m[1]) : 0 };
      }
      type RawButton = {
        text: string;
        callback_data?: string;
        url?: string;
        copy_text?: { text: string };
        style?: string;
        disabled?: object;
      };
      const markup = payload.reply_markup as { inline_keyboard?: RawButton[][]; force_reply?: boolean } | undefined;
      const ephemeral = payload.ephemeral_message_parameters as { receiver_user_id?: number } | undefined;
      const err = (description: string) =>
        new Response(JSON.stringify({ ok: false, error_code: 400, description }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'sendRichMessage' && this.richUnsupported) return err('Bad Request: method not supported');
      if (ephemeral && this.ephemeralUnsupported) return err('Bad Request: ephemeral messages are not available');
      const raw =
        method === 'sendRichMessage' ? String((payload.rich_message as { html?: string })?.html ?? '') : String(payload.text ?? '');
      const markupUsed = method === 'sendRichMessage' || payload.parse_mode === 'HTML';
      this.sent.push({
        method,
        chatId: Number(payload.chat_id),
        text: markupUsed ? toPlain(raw) : raw,
        raw,
        parseMode: payload.parse_mode as string | undefined,
        buttons: (markup?.inline_keyboard ?? []).flat().map((b) => ({
          text: b.text,
          data: b.callback_data,
          url: b.url,
          copy: b.copy_text?.text,
          style: b.style,
          disabled: b.disabled !== undefined,
        })),
        document: method === 'sendDocument',
        protect: payload.protect_content === true,
        ephemeralFor: ephemeral?.receiver_user_id,
        forceReply: markup?.force_reply === true,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: method === 'answerCallbackQuery' ? true : { message_id: 1, date: 0, chat: { id: payload.chat_id, type: 'private' } },
        }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    });
  }

  private overrides() {
    return { db: this.db, chain: this.chain, now: () => this.clock };
  }

  async post(update: Record<string, unknown>, secret = WEBHOOK_SECRET): Promise<Response> {
    return handleFetch(
      new Request(`https://bot.example.workers.dev${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(update),
      }),
      this.env,
      this.overrides(),
    );
  }

  private user(id: number) {
    return { id, is_bot: false, first_name: `U${id}`, username: `user${id}` };
  }

  nextUpdateId(): number {
    this.clock += 5; // real users need a few seconds per action (double-click window is 3 s)
    return this.updateId++;
  }

  async text(userId: number, text: string, chat: { id: number; type: string } = { id: userId, type: 'private' }): Promise<Response> {
    const entities = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] : undefined;
    return this.post({
      update_id: this.nextUpdateId(),
      message: { message_id: this.updateId, date: this.clock, chat, from: this.user(userId), text, ...(entities ? { entities } : {}) },
    });
  }

  async click(userId: number, data: string): Promise<Response> {
    return this.post({
      update_id: this.nextUpdateId(),
      callback_query: {
        id: String(this.updateId),
        from: this.user(userId),
        chat_instance: '1',
        data,
        message: { message_id: 1, date: this.clock, chat: { id: userId, type: 'private' }, text: 'x' },
      },
    });
  }

  async cron(advanceSeconds = 600): Promise<void> {
    this.clock += advanceSeconds;
    await handleScheduled(this.env, this.overrides());
  }

  /** Messages sent to a chat since the given index. */
  to(chatId: number, since = 0): SentMessage[] {
    return this.sent.slice(since).filter((m) => m.chatId === chatId && m.method !== 'answerCallbackQuery');
  }

  last(chatId: number): SentMessage {
    const l = this.to(chatId);
    if (l.length === 0) throw new Error(`no message to ${chatId}`);
    return l[l.length - 1]!;
  }

  button(chatId: number, pattern: RegExp): string {
    for (const m of [...this.to(chatId)].reverse()) {
      const b = m.buttons.find((x) => x.data && pattern.test(x.data));
      if (b) return b.data!;
    }
    throw new Error(`no button ${pattern} for ${chatId}`);
  }

  /** Latest PSBT (base64) sent to a chat. */
  psbt(chatId: number): string {
    for (const m of [...this.to(chatId)].reverse()) {
      const hit = /cHNidP8[A-Za-z0-9+/=]+/.exec(m.text);
      if (hit) return hit[0];
    }
    throw new Error(`no PSBT for ${chatId}`);
  }

  async trade(id: string) {
    return this.db.raw.prepare('SELECT * FROM trades WHERE id = ?').get(id) as { status: string; version: number } & Record<
      string,
      unknown
    >;
  }
}
