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
import { b, code, esc, explorerAddressUrl, i, link, quote, time } from './format.ts';
import { mainMenu, supportMenu, tradeButtons } from './keyboards.ts';
import { feesHtml, feesText, HELP, html, MAIN_MENU, privacyText, SECURITY, termsView, tradeView } from './messages.ts';

/** Buttons that open the picture guides (albums). */
const GUIDE_BUTTONS: Button[][] = [
  [
    { text: '📸 Wallet einrichten', data: 'g:wallet' },
    { text: '📸 Konto prüfen', data: 'g:trade-wallet' },
  ],
  [
    { text: '📸 Einzahlen', data: 'g:deposit' },
    { text: '📸 Unterschreiben', data: 'g:sign' },
  ],
];

const HELP_BUTTONS: Button[][] = [
  [{ text: '➕ Jetzt Handel starten', data: 'm:new', style: 'primary' }],
  [
    { text: '👛 Wallet einrichten', data: 'm:wallet' },
    { text: '🛡 Sicherheit', data: 'm:security' },
  ],
];
import { sendContent } from './send.ts';
import { guideById, guideImageUrls } from './guides.ts';
import { adminNotices, operatorMode } from '../domain/operator.ts';
import {
  arbitrateTrade,
  attentionList,
  blockedUsers,
  failTrade,
  requireAdmin,
  resumeTrade,
  statsLine,
  unblockUser,
} from '../domain/admin.ts';

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

/** Navigation row so users never have to scroll up: back to the trade and/or the main menu. */
function nav(tradeId?: string): Button[] {
  return tradeId
    ? [
        { text: '⬅️ Zurück zum Handel', data: `t:${tradeId}:view` },
        { text: '🏠 Menü', data: 'm:menu' },
      ]
    : [{ text: '🏠 Zurück zum Menü', data: 'm:menu' }];
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
    // metadata only (type, command/callback prefix, chat type) – never message content
    const kind = Object.keys(ctx.update).find((k) => k !== 'update_id') ?? 'unknown';
    const cmd = ctx.message?.text?.match(/^\/\w+/)?.[0] ?? (ctx.callbackQuery?.data ? `cb:${ctx.callbackQuery.data.split(':')[0]}` : '');
    const msgId = ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id ?? '-';
    console.log(`[update] id=${ctx.update.update_id} type=${kind} ${cmd} chat=${ctx.chat?.type ?? '-'} msg=${msgId}`);
    const now = svc.now();
    const r = await db
      .prepare('INSERT OR IGNORE INTO processed_telegram_updates (update_id, processed_at) VALUES (?, ?)')
      .bind(ctx.update.update_id, now)
      .run();
    if (r.meta.changes === 0) return;

    // Same user action delivered again under a new update_id: message by chat+message id,
    // button by user+data within 3 s (also protects against double clicks).
    let actionKey: string | null = null;
    let window = 0;
    if (ctx.message && ctx.chat) actionKey = `m:${ctx.chat.id}:${ctx.message.message_id}`;
    else if (ctx.callbackQuery?.data && ctx.from) {
      actionKey = `c:${ctx.from.id}:${ctx.callbackQuery.data}`;
      window = 3;
    }
    if (actionKey) {
      const a = await db
        .prepare(
          `INSERT INTO recent_actions (key, at) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET at = excluded.at WHERE ? > 0 AND excluded.at - recent_actions.at >= ?`,
        )
        .bind(actionKey, now, window, window)
        .run();
      if (a.meta.changes === 0) {
        console.log(`[update] duplicate action ignored id=${ctx.update.update_id}`);
        if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
        return;
      }
    }
    try {
      await next();
    } catch (e) {
      // allow Telegram to retry after transient failures (e.g. D1 outage)
      await db
        .batch([
          db.prepare('DELETE FROM processed_telegram_updates WHERE update_id = ?').bind(ctx.update.update_id),
          ...(actionKey ? [db.prepare('DELETE FROM recent_actions WHERE key = ? AND at = ?').bind(actionKey, now)] : []),
        ])
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
    const admin = ctx.from && svc.cfg.adminIds.has(ctx.from.id);
    await reply(ctx, MAIN_MENU, admin ? [...mainMenu(), [{ text: '🛎 Admin', data: 'a:home', style: 'primary' }]] : mainMenu());
  }

  /** Sends a picture guide as one swipeable album, with a text version as fallback. */
  async function sendGuide(ctx: Context, id: string) {
    const g = guideById(id);
    if (!g) return;
    const steps = g.cards.map((c, i) => `${b(`${i + 1}. ${esc(c.title)}`)}\n${esc(c.lines.join(' '))}`).join('\n\n');
    await reply(ctx, {
      ...html(
        `${b(`📸 ${esc(g.name)}`)} – ${g.cards.length} Schritte${svc.cfg.publicBaseUrl ? ' (Bilder oben zum Durchwischen)' : ''}\n\n${steps}`,
      ),
      ...(svc.cfg.publicBaseUrl ? { album: guideImageUrls(svc.cfg.publicBaseUrl, g) } : {}),
      buttons: [...GUIDE_BUTTONS, nav()],
    });
  }

  // ---------- admin ----------

  async function showAdmin(ctx: Context, userId: number) {
    const list = await attentionList(svc, userId);
    const rows: Button[][] = list.map((t) => [
      { text: `${t.status === 'NEEDS_REVIEW' ? '⚠️' : '⚖️'} #${t.id} · ${STATE_LABEL_DE[t.status]}`, data: `a:${t.id}:view` },
    ]);
    rows.push([{ text: '🔓 Gesperrte Nutzer', data: 'a:blocked' }], nav());
    await reply(
      ctx,
      html(
        `${b('🛎 Admin')}\n${esc(await statsLine(svc))}\n\n${list.length ? 'Handel, die dich brauchen:' : '✅ Gerade braucht kein Handel deine Hilfe.'}`,
      ),
      rows,
    );
  }

  async function showAdminTrade(ctx: Context, userId: number, tradeId: string) {
    requireAdmin(svc, userId);
    const t = await getTrade(db, tradeId);
    if (!t) throw new UserError('Handel nicht gefunden.');
    const parts = await listParticipants(db, tradeId);
    const rows: Button[][] = [];
    if (t.status === 'NEEDS_REVIEW') {
      rows.push([{ text: '▶️ Fortsetzen (Geld ist da)', data: `a:${tradeId}:resume`, style: 'success' }]);
      if (operatorMode(svc) && userId === svc.cfg.operatorId)
        rows.push([{ text: '⚖️ Als Schlichter entscheiden', data: `a:${tradeId}:arb`, style: 'primary' }]);
      rows.push([{ text: '✖️ Als fehlgeschlagen schließen', data: `a:${tradeId}:fail`, style: 'danger' }]);
    }
    if (t.status === 'DISPUTED' || t.status === 'ARBITRATION')
      rows.push([{ text: '⚖️ Streitfall bearbeiten', data: `d:${tradeId}:take`, style: 'primary' }]);
    rows.push([{ text: '⬅️ Admin', data: 'a:home' }]);
    await reply(ctx, tradeView(t, parts, null), rows);
  }

  async function showTrade(ctx: Context, userId: number, tradeId: string) {
    const a = await authorize(svc, userId, tradeId, 'view_trade');
    const parts = await listParticipants(db, tradeId);
    const session = await getLiveSession(db, tradeId);
    const sigs = session
      ? ((await db.prepare('SELECT COUNT(*) AS n FROM psbt_signatures WHERE session_id = ?').bind(session.id).first<{ n: number }>())?.n ??
        0)
      : 0;
    await reply(
      ctx,
      tradeView(a.trade, parts, a.role, a.participant, sigs),
      tradeButtons(svc.cfg, a.trade, a.participant, a.role, session, sigs),
    );
  }

  async function showTrades(ctx: Context, userId: number) {
    const trades = await listUserTrades(db, userId);
    if (trades.length === 0)
      return reply(ctx, 'Noch keine Handelsfälle.', [[{ text: '➕ Neuen Handel starten', data: 'm:new', style: 'primary' }], nav()]);
    await reply(ctx, html(b('📂 Meine Handelsfälle')), [
      ...trades.map((t): Button[] => [
        { text: `#${t.id} · ${t.title.slice(0, 24)} · ${STATE_LABEL_DE[t.status]}`, data: `t:${t.id}:view` },
      ]),
      nav(),
    ]);
  }

  async function startNewTrade(ctx: Context, userId: number) {
    await setFlow(db, userId, { flow: 'newtrade', step: 'title', data: {} }, svc.now());
    await reply(
      ctx,
      prompt(
        '➕ Neuer Handel – Schritt 1 von 5\n\nWie soll der Handel heißen? Ein kurzer Titel, den alle Beteiligten wiedererkennen (max. 80 Zeichen).\n\n(Mit /cancel kannst du jederzeit abbrechen.)',
        'z. B. MacBook Pro 14 gebraucht',
      ),
    );
  }

  async function showInvites(ctx: Context, userId: number, tradeId: string) {
    const invites = await listInvites(svc, userId, tradeId);
    const rows: Button[][] = [
      [
        { text: 'Käufer einladen', data: `i:${tradeId}:buyer` },
        { text: 'Verkäufer einladen', data: `i:${tradeId}:seller` },
      ],
      ...(operatorMode(svc) ? [] : [[{ text: '⚖️ Schlichter einladen', data: `i:${tradeId}:arbiter`, style: 'primary' } as Button]]),
      [
        { text: 'Vermittler einladen', data: `i:${tradeId}:mediator` },
        { text: 'Beobachter einladen', data: `i:${tradeId}:observer` },
      ],
      ...invites.map((i): Button[] => [
        { text: `Widerrufen: ${ROLE_LABEL_DE[i.role]} (#${i.id})`, data: `r:${tradeId}:${i.id}`, style: 'danger' },
      ]),
    ];
    await reply(
      ctx,
      html(
        `${b(`✉️ Einladungen für #${esc(tradeId)}`)}\nAktive Einladungen: ${invites.length}` +
          (operatorMode(svc) ? '\n\n⚖️ Der Schlichter ist automatisch der Betreiber – du musst nur dein Gegenüber einladen.' : ''),
      ),
      [...rows, nav(tradeId)],
    );
  }

  async function showDisputes(ctx: Context, userId: number) {
    const ds = await listOpenDisputes(svc, userId);
    if (ds.length === 0)
      return void (await reply(ctx, `Keine offenen Streitfälle.\n\n${DISPUTE_LIMITS_TEXT}`, [
        [{ text: 'Support', url: svc.cfg.supportUrl }],
        nav(),
      ]));
    await reply(ctx, html(b('⚖️ Offene Streitfälle')), [
      ...ds.map((d): Button[] => [{ text: `#${d.trade_id} · ${d.status}`, data: `t:${d.trade_id}:view` }]),
      nav(),
    ]);
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
            `${b(`✉️ Du wurdest zu Handel #${esc(r.tradeId)} eingeladen`)} – als ${b(ROLE_LABEL_DE[r.role])}.\n\n` +
              'Hier wird ein Bitcoin-Handel sicher abgewickelt: Das Geld liegt in einem gemeinsamen Treuhand-Konto, ' +
              'das sich nur mit 2 von 3 Unterschriften öffnet. Der Bot selbst hat nie Zugriff darauf.\n\n' +
              `${b('Bitte gib jetzt den Zugangscode ein')}, den du getrennt vom Link bekommen hast (8 Zeichen).\n\n` +
              quote('Die Einladung ist ab jetzt an dein Telegram-Konto gebunden und kann von niemand anderem genutzt werden.'),
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
  bot.command('help', (ctx) => reply(ctx, HELP, [...HELP_BUTTONS, ...GUIDE_BUTTONS, nav()]));
  bot.command('privacy', (ctx) => reply(ctx, privacyText(svc.cfg), [nav()]));
  bot.command('fees', (ctx) => reply(ctx, feesText(svc.cfg), [nav()]));
  bot.command('support', (ctx) => reply(ctx, html(b('🛟 Support')), [...supportMenu(svc.cfg), nav()]));
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
  bot.command('admin', (ctx) => guard(ctx, () => showAdmin(ctx, ctx.from!.id)));
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

      if ((m = /^m:(new|trades|invites|disputes|fees|help|support|security|menu|wallet)$/.exec(data))) {
        switch (m[1]) {
          case 'new':
            return startNewTrade(ctx, userId);
          case 'trades':
          case 'invites':
            return void (await showTrades(ctx, userId));
          case 'disputes':
            return showDisputes(ctx, userId);
          case 'fees':
            return void (await reply(ctx, feesText(svc.cfg), [nav()]));
          case 'help':
            return void (await reply(ctx, HELP, [...HELP_BUTTONS, ...GUIDE_BUTTONS, nav()]));
          case 'support':
            return void (await reply(ctx, html(b('🛟 Support')), [...supportMenu(svc.cfg), nav()]));
          case 'security':
            return void (await reply(ctx, SECURITY, [nav()]));
          case 'wallet':
            return sendGuide(ctx, 'wallet');
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
              `Zugangscode: ${code(inv.accessCode)}\n\n` +
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
      if (data === 'a:home') return showAdmin(ctx, userId);
      if ((m = /^g:([a-z-]{3,20})$/.exec(data))) return sendGuide(ctx, m[1]!);
      if (data === 'a:blocked') {
        const users = await blockedUsers(svc, userId);
        return void (await reply(ctx, users.length ? `Gesperrte Nutzer: ${users.length}` : 'Niemand ist gesperrt.', [
          ...users.map((u): Button[] => [
            { text: `🔓 ${u.username ? '@' + u.username : u.telegram_user_id} entsperren`, data: `a:unblock:${u.telegram_user_id}` },
          ]),
          [{ text: '⬅️ Admin', data: 'a:home' }],
        ]));
      }
      if ((m = /^a:unblock:(\d{1,15})$/.exec(data))) return send(await unblockUser(svc, userId, Number(m[1])));
      if ((m = /^a:([A-Z0-9]{8}):(view|resume|arb|fail)$/.exec(data))) {
        if (m[2] === 'view') return showAdminTrade(ctx, userId, m[1]!);
        if (m[2] === 'resume') return send(await resumeTrade(svc, userId, m[1]!));
        if (m[2] === 'arb') return send(await arbitrateTrade(svc, userId, m[1]!));
        return send(await failTrade(svc, userId, m[1]!));
      }
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
        return void (await reply(ctx, termsView(a.trade), [...(rows ?? []), nav(tradeId)]));
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
        return void (await reply(ctx, html(feesHtml(svc.cfg)), [nav(tradeId)]));
      case 'pay':
        return showPayment(ctx, userId, tradeId);
      case 'inv':
        return showInvites(ctx, userId, tradeId);
      case 'key': {
        const a = await authorize(svc, userId, tradeId, 'register_key');
        const ms = await getMultisig(db, tradeId);
        if (ms) {
          const v = verificationMessage(ms, tradeId);
          return void (await reply(ctx, v, [...(v.buttons ?? []), nav(tradeId)]));
        }
        if (a.trade.status !== 'KEY_SETUP') throw new UserError('Jetzt keine Schlüsselregistrierung.');
        await setFlow(db, userId, { flow: 'key', step: 'key', data: { tradeId } }, svc.now());
        return void (await reply(ctx, {
          ...html(
            `${b(`🔑 Handel #${esc(tradeId)}: Deinen öffentlichen Schlüssel senden`)}\n\n` +
              'Damit wird das gemeinsame Treuhand-Konto gebaut. Der öffentliche Schlüssel ist ungefährlich – damit kann niemand Geld bewegen.\n\n' +
              `${b('So findest du ihn in Sparrow:')}\n` +
              `Neue Multisig-Wallet anlegen (siehe „Wallet einrichten“). Im Keystore stehen ${i('Master fingerprint')}, ${i('Derivation')} und ${i('xpub')}. ` +
              'Schick sie mir in dieser Form in einer Nachricht:\n' +
              `${code(`[fingerprint/48h/${svc.net.coinType}h/0h/2h]tpub…`)}\n` +
              `Beispiel: ${code('[a1b2c3d4/48h/1h/0h/2h]tpubDF…')}\n\n` +
              quote(
                `${b('Niemals')} die Wiederherstellungswörter senden und nie etwas, das mit „tprv“ beginnt. Nutze für jeden Handel ein neues Wallet-Konto.`,
              ),
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
            `📥 Wohin soll das Geld gehen? Sende hier eine Empfangsadresse aus deiner Wallet (Sparrow: Reiter „Receive“).${svc.net.name === 'signet' ? ' Für den Test eine Signet-Adresse, beginnt mit tb1.' : ''}`,
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
    // address only for signing parties, only in private chat
    if (ms && isSigningRole(a.role) && ctx.chat?.type === 'private') {
      markup += `\n\nTreuhandadresse: ${code(ms.address)}`;
      buttons.push([
        { text: '📋 Adresse kopieren', copy: ms.address },
        { text: '🔎 Explorer', url: explorerAddressUrl(svc.net.name, ms.address) },
      ]);
    }
    await reply(ctx, { ...html(markup), buttons: [...buttons, nav(tradeId)] });
  }

  async function onSessionAction(ctx: Context, userId: number, sessionId: string, action: string) {
    const session = await getSession(db, sessionId);
    if (!session) throw new UserError('Session nicht gefunden.');
    const a = await authorize(svc, userId, session.trade_id, 'sign_psbt');
    if (action === 'up') {
      await setFlow(db, userId, { flow: 'psbt', step: 'psbt', data: { sessionId } }, svc.now());
      return void (await reply(
        ctx,
        prompt(
          '✍️ Schick mir jetzt die in deiner Wallet unterschriebene Datei (.psbt) – einfach als Datei anhängen. Alternativ den kopierten Text einfügen.',
          'Datei anhängen oder Text einfügen',
        ),
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
    await send(adminNotices(svc, `Neuer Handel #${t.id}: ${t.title.slice(0, 40)} · ${formatBtc(BigInt(t.amount_sats))} BTC`));
    if (operatorMode(svc)) {
      return void (await reply(
        ctx,
        html(
          `✅ ${b(`Handel #${esc(t.id)} erstellt`)}\n\n` +
            `Als Nächstes lädst du dein Gegenüber (${d.role === 'buyer' ? 'Verkäufer' : 'Käufer'}) ein.\n\n` +
            `⚖️ Der ${b('Schlichter')} ist automatisch der Betreiber. Er greift nur bei Streit ein und kann allein nie auszahlen.`,
        ),
        [[{ text: '✉️ Gegenüber einladen', data: `t:${t.id}:inv`, style: 'primary' }], [{ text: 'Handel öffnen', data: `t:${t.id}:view` }]],
      ));
    }
    await reply(
      ctx,
      html(
        `✅ ${b(`Handel #${esc(t.id)} erstellt`)}\n\nAls Nächstes lädst du ein:\n` +
          `• dein Gegenüber (${d.role === 'buyer' ? 'Verkäufer' : 'Käufer'})\n` +
          `• einen neutralen ${b('Schlichter')} – eine Person, der ihr beide vertraut. Er greift nur bei Streit ein und kann allein nie auszahlen.`,
      ),
      [
        [{ text: '✉️ Einladungen erstellen', data: `t:${t.id}:inv`, style: 'primary' }],
        [{ text: 'Handel öffnen', data: `t:${t.id}:view` }],
      ],
    );
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
          return void (await reply(
            ctx,
            prompt(
              'Schritt 2 von 5 – Was genau wird gehandelt?\n\nBeschreibe Ware oder Leistung so, dass es später keine Missverständnisse gibt (Zustand, Menge, Modell). Bitte keine Adressen oder Telefonnummern.',
              'z. B. 2022, 16 GB RAM, kleine Kratzer',
            ),
          ));
        }
        if (f.step === 'description') {
          d.description = text.slice(0, 2000);
          await setFlow(db, userId, { flow: 'newtrade', step: 'amount', data: d }, now);
          return void (await reply(
            ctx,
            prompt(
              'Schritt 3 von 5 – Wie viel Bitcoin?\n\nDiesen Betrag zahlt der Käufer auf das Treuhand-Konto. Beispiel: 0,01 (= 0,01 BTC) oder 1000000 sat.',
              '0,01',
            ),
          ));
        }
        if (f.step === 'amount') {
          d.amountSats = parseBtcAmount(text).toString();
          await setFlow(db, userId, { flow: 'newtrade', step: 'terms', data: d }, now);
          return void (await reply(
            ctx,
            prompt(
              `✅ Betrag: ${formatBtc(BigInt(d.amountSats))} BTC\n\nSchritt 4 von 5 – Welche Bedingungen gelten?\n\nZ. B. Lieferfrist, Versandart, wann die Ware als angekommen gilt, Rückgabe. Daran orientiert sich der Schlichter im Streitfall.`,
              'Versand in 3 Tagen, versichert …',
            ),
          ));
        }
        if (f.step === 'terms') {
          d.terms = text.slice(0, 4000);
          await setFlow(db, userId, { flow: 'newtrade', step: 'role', data: d }, now);
          return void (await reply(ctx, 'Schritt 5 von 5 – Bist du in diesem Handel Käufer oder Verkäufer?', [
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
