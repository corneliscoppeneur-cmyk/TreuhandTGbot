/** Application wiring shared by the Worker entry, tests and scripts. */
import { parseSignerKey } from './bitcoin/descriptor.ts';
import { parseFeeXpub } from './bitcoin/fee-wallet.ts';
import { addressToScript, getNetwork } from './bitcoin/networks.ts';
import { EsploraProvider } from './blockchain/esplora.ts';
import { CrossCheckedProvider } from './blockchain/fallback.ts';
import type { BlockchainProvider } from './blockchain/provider.ts';
import { ConfigError, parseConfig, type Env } from './config/env.ts';
import type { Db } from './database/client.ts';
import { getSetting } from './database/repo.ts';
import type { ServiceCtx } from './domain/context.ts';
import { runPoller } from './jobs/blockchain-poller.ts';
import { runCleanup } from './jobs/cleanup.ts';
import { logError } from './security/redaction.ts';
import { safeEqual } from './security/tokens.ts';
import { createBot, deliver } from './telegram/bot.ts';

export const WEBHOOK_PATH = '/telegram/webhook';

export interface Overrides {
  db?: Db;
  chain?: BlockchainProvider;
  now?: () => number;
}

export function buildContext(env: Env, o: Overrides = {}): ServiceCtx {
  const cfg = parseConfig(env as unknown as Record<string, unknown>);
  const net = getNetwork(cfg.network);
  try {
    addressToScript(cfg.commissionAddress, net);
  } catch {
    throw new ConfigError('COMMISSION_ADDRESS is not a valid address for the configured network');
  }
  try {
    if (cfg.operatorArbiterKey) parseSignerKey(cfg.operatorArbiterKey, net);
  } catch (e) {
    throw new ConfigError(`OPERATOR_ARBITER_KEY invalid: ${e instanceof Error ? e.message : 'format'}`);
  }
  try {
    if (cfg.commissionXpub) cfg.commissionXpub = parseFeeXpub(cfg.commissionXpub, net);
  } catch (e) {
    throw new ConfigError(e instanceof Error ? e.message : 'COMMISSION_XPUB invalid');
  }
  const chain =
    o.chain ??
    new CrossCheckedProvider(
      new EsploraProvider({ baseUrl: cfg.esploraPrimaryUrl, name: 'esplora-primary' }),
      cfg.esploraSecondaryUrl ? new EsploraProvider({ baseUrl: cfg.esploraSecondaryUrl, name: 'esplora-secondary' }) : null,
    );
  return { db: o.db ?? env.DB, cfg, net, chain, now: o.now ?? (() => Math.floor(Date.now() / 1000)) };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export async function handleFetch(request: Request, env: Env, o: Overrides = {}): Promise<Response> {
  const url = new URL(request.url);
  let svc: ServiceCtx;
  try {
    svc = buildContext(env, o);
  } catch (e) {
    // fail closed: invalid configuration never processes updates
    logError('config', e);
    return json({ ok: false, error: 'configuration invalid' }, 503);
  }

  if (url.pathname === WEBHOOK_PATH) {
    if (request.method !== 'POST') return json({ ok: false }, 405);
    const secret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(secret, svc.cfg.webhookSecret)) return json({ ok: false }, 401);
    const len = Number(request.headers.get('content-length') ?? '0');
    if (len > 1_000_000) return json({ ok: false }, 413);
    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid json' }, 400);
    }
    if (typeof update !== 'object' || update === null || typeof (update as { update_id?: unknown }).update_id !== 'number') {
      return json({ ok: false, error: 'invalid update' }, 400);
    }
    try {
      const bot = createBot(svc);
      await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
      return json({ ok: true });
    } catch (e) {
      logError('webhook', e);
      // 500 → Telegram retries later; idempotency table prevents double processing
      return json({ ok: false }, 500);
    }
  }

  if (url.pathname === '/health') {
    let lastPoll: string | null = null;
    let dbOk = true;
    try {
      lastPoll = await getSetting(svc.db, 'poller_last_run');
    } catch {
      dbOk = false;
    }
    return json({ ok: dbOk, network: svc.net.name, mainnet_enabled: svc.net.name === 'mainnet', last_poll: lastPoll });
  }

  return json({ ok: false }, 404);
}

export async function handleScheduled(env: Env, o: Overrides = {}): Promise<void> {
  const svc = buildContext(env, o);
  const res = await runPoller(svc);
  if (res.notices.length) {
    const bot = createBot(svc);
    await deliver(bot.api, svc, res.notices);
  }
  try {
    await runCleanup(svc);
  } catch (e) {
    logError('cleanup', e);
  }
}
