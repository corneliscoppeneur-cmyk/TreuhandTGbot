import { Bot, GrammyError, InputFile, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { MAX_PSBT_BYTES } from '../config/constants.ts';
import {
  getLiveSession,
  getMultisig,
  getOpenDispute,
  getSession,
  getTrade,
  isUserBlocked,
  listFunding,
  listParticipants,
  listUserTrades,
  upsertUserStmt,
  ConcurrencyError,
} from '../database/repo.ts';
import { AmountError, formatBtc, parseBtcAmount } from '../domain/amount.ts';
import type { Button, MessageContent, Notice, ServiceCtx } from '../domain/context.ts';
import { UserError } from '../domain/context.ts';
import { createInvite, listInvites, revokeInvite, startRedeem, submitAccessCode } from '../domain/invites.ts';
import { confirmAddress, registerKey, reportAddressMismatch, verificationMessage } from '../domain/keys.ts';
import {
  broadcastSession,
  decodeUploadedPsbt,
  markDelivered,
  requestRefund,
  requestRelease,
  sessionSummary,
  submitPayoutAddress,
  submitSignedPsbt,
} from '../domain/payout.ts';
import { PermissionError, ROLE_LABEL_DE, isRole, type Role } from '../domain/permissions.ts';
import { STATE_LABEL_DE, TransitionError } from '../domain/state-machine.ts';
import { agreeTerms, authorize, cancelTrade, createTrade, isSigningRole, linkGroup } from '../domain/trade.ts';
import {
  addDisputeNote,
  decideDispute,
  decisionButtons,
  disputeMessage,
  DISPUTE_LIMITS_TEXT,
  listOpenDisputes,
  openDispute,
  takeCase,
} from '../disputes/disputes.ts';
import { logError } from '../security/redaction.ts';
import { clearFlow, getFlow, setFlow, type Flow } from './conversation.ts';
import { b, code, esc, explorerAddressUrl, i, link, quote, spoiler, time } from './format.ts';
import { mainMenu, supportMenu, tradeButtons } from './keyboards.ts';
import { feesHtml, feesText, HELP, html, MAIN_MENU, privacyText, SECURITY, termsView, tradeView } from './messages.ts';
import { sendContent } from './send.ts';

const TRADE_ID_RE = /^[A-Z0-9]{8}$/;

function botInfo(svc: ServiceCtx): UserFromGetMe {
  return {
    id: Number(svc.cfg.botToken.split(':')[0]),
    is_bot: true,
    first_name: 'BTC Treuhand',
    username: svc.cfg.botUsername,
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  } as UserFromGetMe;
}

/** Sends service notices. A user who blocked the bot is marked unreachable; other notices still go out. */
export async function deliver(api: Bot['api'], svc: ServiceCtx, notices: Notice[]): Promise<void> {
  for (const n of notices) {
    try {
      await sendContent(api, n.chatId, n);
      if (n.document) {
        await api.sendDocument(n.chatId, new InputFile(new TextEncoder().encode(n.document.content), n.document.filename));
      }
    } catch (e) {
      if (e instanceof GrammyError && (e.error_code === 403 || e.error_code === 400)) {
        await svc.db
          .prepare('UPDATE users SET bot_unreachable = 1 WHERE telegram_user_id = ?')
          .bind(n.chatId)
          .run()
          .catch(() => undefined);
      } else {
        logError('deliver', e);
      }
    }
  }
}

function isUserFacing(e: unknown): e is Error {
  return (
    e instanceof UserError ||
    e instanceof PermissionError ||
    e instanceof TransitionError ||
    e instanceof ConcurrencyError ||
    e instanceof AmountError
  );
}

/** A dialog prompt that opens the reply field with a hint. */
function prompt(text: string, placeholder: string): MessageContent {
  return { text, forceReply: { placeholder } };
}

export function createBot(svc: ServiceCtx): Bot {
  // global fetch: native in Workers; lets tests intercept all Bot API calls
  const bot = new Bot(svc.cfg.botToken, {
    botInfo: botInfo(svc),
    client: { fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch },
  });
  const db = svc.db;
  const deepLink = (payload: string) => `https://t.me/${svc.cfg.botUsername}?start=${payload}`;

  const reply = (ctx: Context, content: string | MessageContent, rows?: Button[][]) => {
    const c: MessageContent = typeof content === 'string' ? { text: content } : { ...content };
    if (rows) c.buttons = rows;
    return sendContent(bot.api, ctx.chat!.id, c);
  };

  /** Shows a hint only to the user who triggered it (ephemeral in groups); falls back to a normal reply. */
  async function replyEphemeral(ctx: Context, content: MessageContent, publicFallback: boolean) {
    try {
      await sendContent(bot.api, ctx.chat!.id, content, { ephemeralFor: ctx.from!.id });
    } catch (e) {
      if (!(e instanceof GrammyError)) throw e;
      if (publicFallback) await sendContent(bot.api, ctx.chat!.id, { text: content.text });
    }
  }

  // 1) Idempotency: every update_id is processed at most once.
  bot.use(async (ctx, next) => {
    const r = await db
      .prepare('INSERT OR IGNORE INTO processed_telegram_updates (update_id, processed_at) VALUES (?, ?)')
      .bind(ctx.update.update_id, svc.now())
      .run();
    if (r.meta.changes === 0) return;
    try {
      await next();
    } catch (e) {
      // allow Telegram to retry after transient failures (e.g. D1 outage)
      await db
        .prepare('DELETE FROM processed_telegram_updates WHERE update_id = ?')
        .bind(ctx.update.update_id)
        .run()
        .catch(() => undefined);
      throw e;
    }
  });

  // 2) Users: record, block check, only private chats except group linking/status.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    await upsertUserStmt(db, from.id, from.username ?? null, svc.now()).run();
    if (await isUserBlocked(db, from.id)) return;
    if (ctx.chat && ctx.chat.type !== 'private') {
      const text = ctx.message?.text ?? '';
      if (/^\/(link|status)(@\w+)?\b/.test(text)) return next();
      if (/^\/\w+/.test(text)) {
        await replyEphemeral(
          ctx,
          {
            text: 'Bitte nutze den Bot im privaten Chat. In Gruppen werden nur Statusmeldungen angezeigt.',
            buttons: [[{ text: 'Privat öffnen', url: deepLink('menu'), style: 'primary' }]],
          },
          true,
        );
      }
      return;
    }
    return next();
  });

  const send = (ns: Notice[]) => deliver(bot.api, svc, ns);

  async function guard(ctx: Context, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      if (isUserFacing(e)) {
        await reply(ctx, e.message);
        return;
      }
      logError('handler', e);
      throw e;
    }
  }

  async function showMenu(ctx: Context) {
    await reply(ctx, MAIN_MENU, mainMenu());
  }

  async function showTrade(ctx: Context, userId: number, tradeId: string) {
    const a = await authorize(svc, userId, tradeId, 'view_trade');
    const parts = await listParticipants(db, tradeId);
    const session = await getLiveSession(db, tradeId);
    const sigs = session
      ? ((await db.prepare('SELECT COUNT(*) AS n FROM psbt_signatures WHERE session_id = ?').bind(session.id).first<{ n: number }>())?.n ??
        0)
      : 0;
    await reply(ctx, tradeView(a.trade, parts, a.role), tradeButtons(svc.cfg, a.trade, a.participant, a.role, session, sigs));
  }

  async function showTrades(ctx: Context, userId: number) {
    const trades = await listUserTrades(db, userId);
    if (trades.length === 0)
      return reply(ctx, 'Noch keine Handelsfälle.', [[{ text: '➕ Neuen Handel erstellen', data: 'm:new', style: 'primary' }]]);
    await reply(
      ctx,
      html(b('📂 Meine Handelsfälle')),
      trades.map((t) => [{ text: `#${t.id} · ${t.title.slice(0, 24)} · ${STATE_LABEL_DE[t.status]}`, data: `t:${t.id}:view` }]),
    );
  }

  async function startNewTrade(ctx: Context, userId: number) {
    await setFlow(db, userId, { flow: 'newtrade', step: 'title', data: {} }, svc.now());
    await reply(
      ctx,
      prompt('Neuer Handel – Schritt 1/6\nTitel des Handels (max. 80 Zeichen):\n\n(/cancel bricht ab)', 'z. B. Laptop Modell X'),
    );
  }

  async function showInvites(ctx: Context, userId: number, tradeId: string) {
    const invites = await listInvites(svc, userId, tradeId);
    const rows: Button[][] = [
      [
        { text: 'Käufer einladen', data: `i:${tradeId}:buyer` },
        { text: 'Verkäufer einladen', data: `i:${tradeId}:seller` },
      ],
      [{ text: '⚖️ Schlichter einladen', data: `i:${tradeId}:arbiter`, style: 'primary' }],
      [
        { text: 'Vermittler einladen', data: `i:${tradeId}:mediator` },
        { text: 'Beobachter einladen', data: `i:${tradeId}:observer` },
      ],
      ...invites.map((i): Button[] => [
        { text: `Widerrufen: ${ROLE_LABEL_DE[i.role]} (#${i.id})`, data: `r:${tradeId}:${i.id}`, style: 'danger' },
      ]),
    ];
    await reply(ctx, html(`${b(`✉️ Einladungen für #${esc(tradeId)}`)}\nAktive Einladungen: ${invites.length}`), rows);
  }

  async function showDisputes(ctx: Context, userId: number) {
    const ds = await listOpenDisputes(svc, userId);
    if (ds.length === 0)
      return void (await reply(ctx, `Keine offenen Streitfälle.\n\n${DISPUTE_LIMITS_TEXT}`, [
        [{ text: 'Support', url: svc.cfg.supportUrl }],
      ]));
    await reply(
      ctx,
      html(b('⚖️ Offene Streitfälle')),
      ds.map((d) => [{ text: `#${d.trade_id} · ${d.status}`, data: `t:${d.trade_id}:view` }]),
    );
  }

  // ---------- commands ----------

  bot.command('start', (ctx) =>
    guard(ctx, async () => {
      const userId = ctx.from!.id;
      const payload = ctx.match.trim();
      if (payload.startsWith('i_')) {
        const r = await startRedeem(svc, userId, payload.slice(2));
        await setFlow(db, userId, { flow: 'invite_code', step: 'code', data: { inviteId: r.inviteId } }, svc.now());
        await reply(ctx, {
          ...html(
            `${b(`✉️ Einladung zu Handel #${esc(r.tradeId)}`)} als ${b(ROLE_LABEL_DE[r.role])}.\n\n` +
              'Bitte den Zugangscode eingeben, den du separat vom Einladenden erhalten hast.\n\n' +
              quote('Diese Einladung ist jetzt an dein Telegram-Konto gebunden.'),
          ),
          forceReply: { placeholder: 'Zugangscode (8 Zeichen)' },
        });
        return;
      }
      const t = /^t_([A-Z0-9]{8})$/.exec(payload);
      if (t) return showTrade(ctx, userId, t[1]!);
      await showMenu(ctx);
    }),
  );
  bot.command('help', (ctx) => reply(ctx, HELP, [[{ text: 'Sicherheitsinformationen', data: 'm:security' }]]));
  bot.command('privacy', (ctx) => reply(ctx, privacyText(svc.cfg)));
  bot.command('fees', (ctx) => reply(ctx, feesText(svc.cfg)));
  bot.command('support', (ctx) => reply(ctx, html(b('🛟 Support')), supportMenu(svc.cfg)));
  bot.command('newtrade', (ctx) => guard(ctx, () => startNewTrade(ctx, ctx.from!.id)));
  bot.command('mytrades', (ctx) => guard(ctx, async () => void (await showTrades(ctx, ctx.from!.id))));
  bot.command('cancel', async (ctx) => {
    await clearFlow(db, ctx.from!.id);
    await reply(ctx, 'Abgebrochen.', mainMenu());
  });
  bot.command('trade', (ctx) =>
    guard(ctx, async () => {
      const id = ctx.match.trim().replace(/^#/, '').toUpperCase();
      if (!TRADE_ID_RE.test(id)) return void (await reply(ctx, 'Nutzung: /trade <ID>'));
      await showTrade(ctx, ctx.from!.id, id);
    }),
  );
  bot.command('invites', (ctx) =>
    guard(ctx, async () => {
      const id = ctx.match.trim().replace(/^#/, '').toUpperCase();
      if (!TRADE_ID_RE.test(id)) return void (await showTrades(ctx, ctx.from!.id));
      await showInvites(ctx, ctx.from!.id, id);
    }),
  );
  bot.command('disputes', (ctx) => guard(ctx, () => showDisputes(ctx, ctx.from!.id)));
  bot.command('status', (ctx) =>
    guard(ctx, async () => {
      const id = ctx.match.trim().replace(/^#/, '').toUpperCase();
      if (TRADE_ID_RE.test(id)) {
        const a = await authorize(svc, ctx.from!.id, id, 'view_trade');
        // status only – safe for groups
        await reply(ctx, html(`Handel #${esc(id)}: ${b(esc(STATE_LABEL_DE[a.trade.status]))}`));
        if (ctx.chat?.type !== 'private') {
          await replyEphemeral(
            ctx,
            { text: 'Details nur privat:', buttons: [[{ text: '🔒 Handel privat öffnen', url: deepLink(`t_${id}`), style: 'primary' }]] },
            false,
          );
        }
        return;
      }
      await reply(ctx, `Bot aktiv. Netzwerk: ${svc.net.name}. Mainnet: ${svc.net.name === 'mainnet' ? 'aktiv' : 'gesperrt'}.`);
    }),
  );
  bot.command('link', (ctx) =>
    guard(ctx, async () => {
      const id = ctx.match.trim().replace(/^#/, '').toUpperCase();
      if (!TRADE_ID_RE.test(id) || !ctx.chat) return void (await reply(ctx, 'Nutzung in der Gruppe: /link <ID>'));
      await linkGroup(svc, ctx.from!.id, id, ctx.chat.id);
      await reply(
        ctx,
        html(
          `${b(`🔗 Gruppe mit Handel #${esc(id)} verknüpft.`)}\nHier erscheinen nur Statusmeldungen – keine Adressen, Schlüssel oder Zahlungsdaten.\n\n` +
            `Für sensible Inhalte: ${link(svc.cfg.cryptgeonUrl, 'verschlüsselter Einmal-Link (cryptgeon)')}`,
        ),
      );
    }),
  );

  // ---------- callbacks ----------

  bot.on('callback_query:data', (ctx) =>
    guard(ctx, async () => {
      await ctx.answerCallbackQuery().catch(() => undefined);
      const data = ctx.callbackQuery.data;
      const userId = ctx.from.id;
      let m: RegExpExecArray | null;

      if ((m = /^m:(new|trades|invites|disputes|fees|help|support|security|menu)$/.exec(data))) {
        switch (m[1]) {
          case 'new':
            return startNewTrade(ctx, userId);
          case 'trades':
          case 'invites':
            return void (await showTrades(ctx, userId));
          case 'disputes':
            return showDisputes(ctx, userId);
          case 'fees':
            return void (await reply(ctx, feesText(svc.cfg)));
          case 'help':
            return void (await reply(ctx, HELP, [[{ text: 'Sicherheitsinformationen', data: 'm:security' }]]));
          case 'support':
            return void (await reply(ctx, html(b('🛟 Support')), supportMenu(svc.cfg)));
          case 'security':
            return void (await reply(ctx, SECURITY));
          default:
            return showMenu(ctx);
        }
      }

      if ((m = /^n:role:(buyer|seller)$/.exec(data))) return onNewTradeRole(ctx, userId, m[1] as 'buyer' | 'seller');
      if (data === 'n:confirm') return onNewTradeConfirm(ctx, userId);

      if ((m = /^i:([A-Z0-9]{8}):([a-z]+)$/.exec(data))) {
        if (!isRole(m[2]!)) return;
        const inv = await createInvite(svc, userId, m[1]!, m[2] as Role);
        await reply(ctx, {
          ...html(
            `${b(`✉️ Einladung als ${ROLE_LABEL_DE[inv.role]} für #${esc(m[1]!)}`)}\n` +
              `Einmalig, gültig bis ${time(inv.expiresAt, 'wDT')} (${time(inv.expiresAt, 'r')}).\n\n` +
              `Link:\n${code(inv.link)}\n\n` +
              `Zugangscode (antippen zum Anzeigen): ${spoiler(esc(inv.accessCode))}\n\n` +
              quote(
                `Sende Link und Code auf GETRENNTEN Wegen, z. B. den Code per ${link(svc.cfg.cryptgeonUrl, 'verschlüsseltem Einmal-Link')}. ` +
                  'Der Link wird beim ersten Öffnen an dieses Telegram-Konto gebunden.',
              ),
          ),
          buttons: [
            [
              { text: '📋 Link kopieren', copy: inv.link, style: 'primary' },
              { text: '📋 Code kopieren', copy: inv.accessCode },
            ],
          ],
        });
        return;
      }
      if ((m = /^r:([A-Z0-9]{8}):(\d{1,12})$/.exec(data))) {
        await revokeInvite(svc, userId, m[1]!, Number(m[2]));
        return void (await reply(ctx, 'Einladung widerrufen.'));
      }

      if ((m = /^t:([A-Z0-9]{8}):([a-z]+)(?::([A-Za-z0-9_-]{1,20}))?$/.exec(data))) return onTradeAction(ctx, userId, m[1]!, m[2]!, m[3]);
      if ((m = /^s:([A-Za-z0-9_-]{16}):(up|bc|show)$/.exec(data))) return onSessionAction(ctx, userId, m[1]!, m[2]!);
      if ((m = /^d:([A-Z0-9]{8}):(take|release|refund|ask)$/.exec(data))) return onDisputeAction(ctx, userId, m[1]!, m[2]!);
    }),
  );

  async function onTradeAction(ctx: Context, userId: number, tradeId: string, action: string, arg?: string) {
    switch (action) {
      case 'view':
        return showTrade(ctx, userId, tradeId);
      case 'terms': {
        const a = await authorize(svc, userId, tradeId, 'view_trade');
        const rows: Button[][] | undefined =
          a.trade.status === 'AGREEMENT' && a.participant && a.participant.agreed_hash !== a.trade.agreement_hash && isSigningRole(a.role)
            ? [
                [
                  {
                    text: '✅ Bedingungen akzeptieren',
                    data: `t:${tradeId}:agree:${a.trade.agreement_hash!.slice(0, 16)}`,
                    style: 'success',
                  },
                ],
              ]
            : undefined;
        return void (await reply(ctx, termsView(a.trade), rows));
      }
      case 'agree':
        return send(await agreeTerms(svc, userId, tradeId, arg ?? ''));
      case 'parts': {
        await authorize(svc, userId, tradeId, 'view_participants');
        const parts = await listParticipants(db, tradeId);
        // no usernames/ids exposed: roles and join time only
        return void (await reply(
          ctx,
          html(
            `${b(`👥 Teilnehmer #${esc(tradeId)}`)}\n` +
              parts
                .map((p) => `• ${ROLE_LABEL_DE[p.role]}${p.telegram_user_id === userId ? ' (du)' : ''} · seit ${time(p.joined_at, 'dt')}`)
                .join('\n'),
          ),
        ));
      }
      case 'fees':
        await authorize(svc, userId, tradeId, 'view_trade');
        return void (await reply(ctx, html(feesHtml(svc.cfg))));
      case 'pay':
        return showPayment(ctx, userId, tradeId);
      case 'inv':
        return showInvites(ctx, userId, tradeId);
      case 'key': {
        const a = await authorize(svc, userId, tradeId, 'register_key');
        const ms = await getMultisig(db, tradeId);
        if (ms) return void (await reply(ctx, verificationMessage(ms, tradeId)));
        if (a.trade.status !== 'KEY_SETUP') throw new UserError('Jetzt keine Schlüsselregistrierung.');
        await setFlow(db, userId, { flow: 'key', step: 'key', data: { tradeId } }, svc.now());
        return void (await reply(ctx, {
          ...html(
            `${b(`🔑 Öffentlichen Multisig-Schlüssel für #${esc(tradeId)} senden`)}\n\n` +
              `Format: ${code(`[fingerprint/48h/${svc.net.coinType}h/<konto>h/2h]tpub…`)}\n\n` +
              'Sparrow: Neue Wallet → Multisig → Keystore „Watch-only/xPub“ → Key-Origin und tpub kopieren.\n' +
              quote(`${b('Nutze ein NEUES Konto nur für diesen Handel. NIEMALS Seed oder tprv senden!')}`),
          ),
          forceReply: { placeholder: '[fingerprint/48h/1h/0h/2h]tpub…' },
        }));
      }
      case 'verify':
        return send(await confirmAddress(svc, userId, tradeId, arg ?? ''));
      case 'verifyfail':
        return send(await reportAddressMismatch(svc, userId, tradeId));
      case 'delivered':
        return send(await markDelivered(svc, userId, tradeId));
      case 'release':
        return send(await requestRelease(svc, userId, tradeId));
      case 'refund':
        return send(await requestRefund(svc, userId, tradeId));
      case 'addr':
        await authorize(svc, userId, tradeId, 'view_payment_details');
        await setFlow(db, userId, { flow: 'addr', step: 'addr', data: { tradeId } }, svc.now());
        return void (await reply(
          ctx,
          prompt(
            `Sende jetzt deine ${svc.net.name}-Empfangsadresse für #${tradeId} (nur hier privat).`,
            svc.net.name === 'signet' ? 'tb1q…' : 'bc1q…',
          ),
        ));
      case 'cancel':
        return void (await reply(ctx, `Handel #${tradeId} wirklich abbrechen?`, [
          [
            { text: 'Ja, abbrechen', data: `t:${tradeId}:cancelok`, style: 'danger' },
            { text: 'Nein', data: `t:${tradeId}:view` },
          ],
        ]));
      case 'cancelok':
        await send(await cancelTrade(svc, userId, tradeId));
        return void (await reply(ctx, `Handel #${tradeId} abgebrochen.`));
      case 'dispute': {
        const a = await authorize(svc, userId, tradeId, 'view_trade');
        if (a.role !== 'buyer' && a.role !== 'seller')
          return void (await reply(ctx, 'Streitfälle eröffnen Käufer oder Verkäufer. Support:', supportMenu(svc.cfg)));
        if (await getOpenDispute(db, tradeId))
          return void (await reply(ctx, 'Es gibt bereits einen offenen Streitfall.', [
            [{ text: 'Stellungnahme senden', data: `d:${tradeId}:ask` }],
          ]));
        await setFlow(db, userId, { flow: 'dispute', step: 'reason', data: { tradeId } }, svc.now());
        return void (await reply(ctx, {
          ...html(
            `${b(`⚠️ Probleme mit Handel #${esc(tradeId)}`)}\n\n${quote(esc(DISPUTE_LIMITS_TEXT), true)}\n\n` +
              `Bitte beschreibe das Problem (keine privaten Daten, ggf. ${link(svc.cfg.cryptgeonUrl, 'Cryptgeon-Link')}):`,
          ),
          protect: true,
          forceReply: { placeholder: 'Was ist passiert?' },
        }));
      }
    }
  }

  async function showPayment(ctx: Context, userId: number, tradeId: string) {
    const a = await authorize(svc, userId, tradeId, 'view_trade');
    const ms = await getMultisig(db, tradeId);
    const funding = await listFunding(db, tradeId);
    const seen = funding.filter((f) => f.status === 'confirmed' || f.status === 'unconfirmed');
    const sum = seen.reduce((s, f) => s + BigInt(f.value_sats), 0n);
    let markup =
      `${b(`💰 Zahlungsstatus #${esc(tradeId)}`)}: ${esc(STATE_LABEL_DE[a.trade.status])}\n` +
      `Erwartet: ${b(esc(formatBtc(BigInt(a.trade.amount_sats))))} BTC\n` +
      `Gesehen: ${seen.length} Zahlung(en), Summe ${esc(formatBtc(sum))} BTC, bestätigt: ${seen.filter((f) => f.status === 'confirmed').length}`;
    const buttons: Button[][] = [];
    // address only for signing parties, only in private chat, hidden behind a spoiler
    if (ms && isSigningRole(a.role) && ctx.chat?.type === 'private') {
      markup += `\n\nTreuhandadresse (antippen): ${spoiler(esc(ms.address))}`;
      buttons.push([
        { text: '📋 Adresse kopieren', copy: ms.address },
        { text: '🔎 Explorer', url: explorerAddressUrl(svc.net.name, ms.address) },
      ]);
    }
    await reply(ctx, { ...html(markup), buttons });
  }

  async function onSessionAction(ctx: Context, userId: number, sessionId: string, action: string) {
    const session = await getSession(db, sessionId);
    if (!session) throw new UserError('Session nicht gefunden.');
    const a = await authorize(svc, userId, session.trade_id, 'sign_psbt');
    if (action === 'up') {
      await setFlow(db, userId, { flow: 'psbt', step: 'psbt', data: { sessionId } }, svc.now());
      return void (await reply(
        ctx,
        prompt('Sende jetzt die in deiner Wallet signierte PSBT (Base64-Text oder .psbt-Datei).', 'cHNidP8… oder Datei'),
      ));
    }
    if (action === 'show') {
      await reply(ctx, sessionSummary(a.trade, session, svc.net.name));
      return deliver(bot.api, svc, [
        {
          chatId: userId,
          text: 'PSBT-Datei:',
          document: { filename: `trade-${a.trade.id}-${session.id}.psbt`, content: session.base_psbt },
        },
      ]);
    }
    return send(await broadcastSession(svc, userId, sessionId));
  }

  async function onDisputeAction(ctx: Context, userId: number, tradeId: string, action: string) {
    if (action === 'take') {
      const t = await getTrade(db, tradeId);
      if (t?.status === 'ARBITRATION') {
        await authorize(svc, userId, tradeId, 'decide_dispute');
        const d = await getOpenDispute(db, tradeId);
        return void (await reply(ctx, d ? disputeMessage(d) : 'Kein Streitfall', decisionButtons(tradeId)));
      }
      return send(await takeCase(svc, userId, tradeId));
    }
    if (action === 'ask') {
      await authorize(svc, userId, tradeId, 'view_dispute');
      await setFlow(db, userId, { flow: 'dnote', step: 'note', data: { tradeId } }, svc.now());
      return void (await reply(ctx, {
        ...prompt('Nachricht zum Streitfall eingeben (geht an Käufer, Verkäufer und Schlichter, keine privaten Daten):', 'Nachricht'),
        protect: true,
      }));
    }
    await authorize(svc, userId, tradeId, 'decide_dispute');
    await setFlow(db, userId, { flow: 'decide', step: 'note', data: { tradeId, decision: action as 'release' | 'refund' } }, svc.now());
    await reply(ctx, {
      ...prompt(
        `Entscheidung „${action === 'release' ? 'Release an Verkäufer' : 'Refund an Käufer'}“ – bitte Begründung eingeben (wird dokumentiert):`,
        'Begründung',
      ),
      protect: true,
    });
  }

  async function onNewTradeRole(ctx: Context, userId: number, role: 'buyer' | 'seller') {
    const f = await getFlow(db, userId, svc.now());
    if (!f || f.flow !== 'newtrade' || f.step !== 'role') throw new UserError('Kein aktiver Dialog. /newtrade');
    const d = { ...f.data, role };
    await setFlow(db, userId, { flow: 'newtrade', step: 'confirm', data: d }, svc.now());
    await reply(
      ctx,
      html(
        `${b('📝 Zusammenfassung – bitte prüfen')}\n\n` +
          `Titel: ${b(esc(d.title ?? ''))}\nBeschreibung: ${esc(d.description ?? '')}\n` +
          `Betrag: ${b(esc(formatBtc(BigInt(d.amountSats!))))} BTC\nBedingungen: ${esc(d.terms ?? '')}\n` +
          `Deine Rolle: ${b(ROLE_LABEL_DE[role])}\n\n${feesHtml(svc.cfg)}\n\n${i(esc('Mit „Erstellen“ akzeptierst du dieses Gebührenmodell.'))}`,
      ),
      [
        [
          { text: '✅ Erstellen', data: 'n:confirm', style: 'success' },
          { text: 'Abbrechen', data: 'm:menu', style: 'danger' },
        ],
      ],
    );
  }

  async function onNewTradeConfirm(ctx: Context, userId: number) {
    const f = await getFlow(db, userId, svc.now());
    if (!f || f.flow !== 'newtrade' || f.step !== 'confirm') throw new UserError('Kein aktiver Dialog. /newtrade');
    const d = f.data;
    const t = await createTrade(svc, userId, {
      title: d.title!,
      description: d.description!,
      terms: d.terms!,
      amountSats: BigInt(d.amountSats!),
      creatorRole: d.role!,
    });
    await clearFlow(db, userId);
    await reply(ctx, `Handel #${t.id} erstellt. Lade jetzt die anderen Parteien ein (Käufer/Verkäufer und ein unabhängiger Schlichter).`, [
      [{ text: '✉️ Einladungen erstellen', data: `t:${t.id}:inv`, style: 'primary' }],
      [{ text: 'Handel öffnen', data: `t:${t.id}:view` }],
    ]);
  }

  // ---------- free text / documents (dialog steps) ----------

  async function handleFlowText(ctx: Context, userId: number, f: Flow, text: string) {
    const now = svc.now();
    switch (f.flow) {
      case 'newtrade': {
        const d = { ...f.data };
        if (f.step === 'title') {
          d.title = text.slice(0, 200);
          await setFlow(db, userId, { flow: 'newtrade', step: 'description', data: d }, now);
          return void (await reply(ctx, prompt('Schritt 2/6 – Beschreibung (keine persönlichen Daten):', 'Was wird gehandelt?')));
        }
        if (f.step === 'description') {
          d.description = text.slice(0, 2000);
          await setFlow(db, userId, { flow: 'newtrade', step: 'amount', data: d }, now);
          return void (await reply(ctx, prompt('Schritt 3/6 – BTC-Betrag (z. B. 0,01 oder 1000000 sat):', '0,01')));
        }
        if (f.step === 'amount') {
          d.amountSats = parseBtcAmount(text).toString();
          await setFlow(db, userId, { flow: 'newtrade', step: 'terms', data: d }, now);
          return void (await reply(
            ctx,
            prompt(
              `Betrag: ${formatBtc(BigInt(d.amountSats))} BTC\n\nSchritt 4/6 – Handelsbedingungen (Lieferung, Fristen, Rückgabe):`,
              'Lieferung binnen 7 Tagen …',
            ),
          ));
        }
        if (f.step === 'terms') {
          d.terms = text.slice(0, 4000);
          await setFlow(db, userId, { flow: 'newtrade', step: 'role', data: d }, now);
          return void (await reply(ctx, 'Schritt 5/6 – Deine Rolle:', [
            [
              { text: '🛒 Ich bin Käufer', data: 'n:role:buyer', style: 'primary' },
              { text: '📦 Ich bin Verkäufer', data: 'n:role:seller', style: 'primary' },
            ],
          ]));
        }
        return void (await reply(ctx, 'Bitte die Buttons verwenden oder /cancel.'));
      }
      case 'invite_code': {
        const notices = await submitAccessCode(svc, userId, f.data.inviteId, text);
        await clearFlow(db, userId);
        return send(notices);
      }
      case 'key': {
        const notices = await registerKey(svc, userId, f.data.tradeId, text);
        await clearFlow(db, userId);
        return send(notices);
      }
      case 'addr': {
        const notices = await submitPayoutAddress(svc, userId, f.data.tradeId, text);
        await clearFlow(db, userId);
        return send(notices);
      }
      case 'psbt': {
        const notices = await submitSignedPsbt(svc, userId, f.data.sessionId, decodeUploadedPsbt(text));
        await clearFlow(db, userId);
        return send(notices);
      }
      case 'dispute': {
        if (f.step === 'reason') {
          await setFlow(
            db,
            userId,
            { flow: 'dispute', step: 'links', data: { tradeId: f.data.tradeId, reason: text.slice(0, 3000) } },
            now,
          );
          return void (await reply(
            ctx,
            prompt('Optional: externe Beweislinks (https, durch Leerzeichen getrennt) – oder „-“ für keine:', 'https://… oder -'),
          ));
        }
        const links = text.trim() === '-' ? null : text;
        const notices = await openDispute(svc, userId, f.data.tradeId, f.data.reason ?? '', links);
        await clearFlow(db, userId);
        return send(notices);
      }
      case 'dnote': {
        const notices = await addDisputeNote(svc, userId, f.data.tradeId, text);
        await clearFlow(db, userId);
        await reply(ctx, 'Gesendet.');
        return send(notices);
      }
      case 'decide': {
        const notices = await decideDispute(svc, userId, f.data.tradeId, f.data.decision, text);
        await clearFlow(db, userId);
        return send(notices);
      }
    }
  }

  bot.on('message:text', (ctx) =>
    guard(ctx, async () => {
      const userId = ctx.from.id;
      const f = await getFlow(db, userId, svc.now());
      if (!f) return showMenu(ctx);
      await handleFlowText(ctx, userId, f, ctx.message.text);
    }),
  );

  bot.on('message:document', (ctx) =>
    guard(ctx, async () => {
      const userId = ctx.from.id;
      const f = await getFlow(db, userId, svc.now());
      if (!f || f.flow !== 'psbt') return void (await reply(ctx, 'Dateien werden nur beim PSBT-Upload angenommen.'));
      const doc = ctx.message.document;
      if ((doc.file_size ?? 0) > MAX_PSBT_BYTES * 2) throw new UserError('Datei zu groß.');
      const file = await ctx.api.getFile(doc.file_id);
      if (!file.file_path) throw new UserError('Datei nicht abrufbar.');
      const res = await fetch(`https://api.telegram.org/file/bot${svc.cfg.botToken}/${file.file_path}`);
      if (!res.ok) throw new UserError('Datei konnte nicht geladen werden.');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_PSBT_BYTES * 2) throw new UserError('Datei zu groß.');
      // .psbt files are binary (magic 'psbt\xff') or base64 text
      const isBinary = bytes[0] === 0x70 && bytes[1] === 0x73 && bytes[2] === 0x62 && bytes[3] === 0x74 && bytes[4] === 0xff;
      const psbt = isBinary ? bytes : decodeUploadedPsbt(new TextDecoder().decode(bytes));
      const notices = await submitSignedPsbt(svc, userId, f.data.sessionId, psbt);
      await clearFlow(db, userId);
      await send(notices);
    }),
  );

  bot.on('message', (ctx) => reply(ctx, MAIN_MENU, mainMenu()));

  return bot;
}
