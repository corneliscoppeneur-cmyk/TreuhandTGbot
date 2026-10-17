import { Bot, GrammyError, InputFile, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { MAX_PSBT_BYTES, TELEGRAM_MAX_MESSAGE_CHARS } from '../config/constants.ts';
import { getLiveSession, getMultisig, getOpenDispute, getSession, getTrade, isUserBlocked, listFunding, listParticipants, listUserTrades, upsertUserStmt, ConcurrencyError } from '../database/repo.ts';
import { AmountError, formatBtc, parseBtcAmount } from '../domain/amount.ts';
import type { Notice, ServiceCtx } from '../domain/context.ts';
import { UserError } from '../domain/context.ts';
import { createInvite, listInvites, revokeInvite, startRedeem, submitAccessCode } from '../domain/invites.ts';
import { confirmAddress, registerKey, reportAddressMismatch, verificationText } from '../domain/keys.ts';
import { broadcastSession, decodeUploadedPsbt, markDelivered, requestRefund, requestRelease, sessionSummary, submitPayoutAddress, submitSignedPsbt } from '../domain/payout.ts';
import { PermissionError, ROLE_LABEL_DE, isRole, type Role } from '../domain/permissions.ts';
import { STATE_LABEL_DE, TransitionError } from '../domain/state-machine.ts';
import { agreeTerms, authorize, cancelTrade, createTrade, linkGroup } from '../domain/trade.ts';
import { addDisputeNote, decideDispute, disputeText, DISPUTE_LIMITS_TEXT, listOpenDisputes, openDispute, takeCase } from '../disputes/disputes.ts';
import { logError } from '../security/redaction.ts';
import { clearFlow, getFlow, setFlow, type Flow } from './conversation.ts';
import { mainMenu, supportMenu, toKeyboard, tradeButtons } from './keyboards.ts';
import { feesText, HELP_TEXT, MAIN_MENU_TEXT, privacyText, securityText, termsView, tradeView } from './messages.ts';

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
      const text = n.text.length > TELEGRAM_MAX_MESSAGE_CHARS ? `${n.text.slice(0, TELEGRAM_MAX_MESSAGE_CHARS - 1)}…` : n.text;
      const kb = toKeyboard(n.buttons);
      await api.sendMessage(n.chatId, text, { ...(kb ? { reply_markup: kb } : {}), link_preview_options: { is_disabled: true } });
      if (n.document) {
        await api.sendDocument(n.chatId, new InputFile(new TextEncoder().encode(n.document.content), n.document.filename));
      }
    } catch (e) {
      if (e instanceof GrammyError && (e.error_code === 403 || e.error_code === 400)) {
        await svc.db.prepare('UPDATE users SET bot_unreachable = 1 WHERE telegram_user_id = ?').bind(n.chatId).run().catch(() => undefined);
      } else {
        logError('deliver', e);
      }
    }
  }
}

function isUserFacing(e: unknown): e is Error {
  return (
    e instanceof UserError || e instanceof PermissionError || e instanceof TransitionError || e instanceof ConcurrencyError || e instanceof AmountError
  );
}

export function createBot(svc: ServiceCtx): Bot {
  // global fetch: native in Workers; lets tests intercept all Bot API calls
  const bot = new Bot(svc.cfg.botToken, {
    botInfo: botInfo(svc),
    client: { fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch },
  });
  const db = svc.db;

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
      await db.prepare('DELETE FROM processed_telegram_updates WHERE update_id = ?').bind(ctx.update.update_id).run().catch(() => undefined);
      throw e;
    }
  });

  // 2) Users: record, block check, only private chats except group linking.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    await upsertUserStmt(db, from.id, from.username ?? null, svc.now()).run();
    if (await isUserBlocked(db, from.id)) return;
    if (ctx.chat && ctx.chat.type !== 'private') {
      const text = ctx.message?.text ?? '';
      if (/^\/(link|status)(@\w+)?\b/.test(text)) return next();
      if (/^\/\w+/.test(text)) await ctx.reply('Bitte nutze den Bot im privaten Chat. In Gruppen werden nur Statusmeldungen angezeigt.');
      return;
    }
    return next();
  });

  const send = (ns: Notice[]) => deliver(bot.api, svc, ns);
  const reply = (ctx: Context, text: string, rows?: Notice['buttons']) => {
    const kb = toKeyboard(rows);
    return ctx.reply(text, { ...(kb ? { reply_markup: kb } : {}), link_preview_options: { is_disabled: true } });
  };

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
    await reply(ctx, MAIN_MENU_TEXT, mainMenu());
  }

  async function showTrade(ctx: Context, userId: number, tradeId: string) {
    const a = await authorize(svc, userId, tradeId, 'view_trade');
    const parts = await listParticipants(db, tradeId);
    const session = await getLiveSession(db, tradeId);
    await reply(ctx, tradeView(a.trade, parts, a.role), tradeButtons(svc.cfg, a.trade, a.participant, a.role, session));
  }

  async function showTrades(ctx: Context, userId: number) {
    const trades = await listUserTrades(db, userId);
    if (trades.length === 0) return reply(ctx, 'Noch keine Handelsfälle.', [[{ text: 'Neuen Handel erstellen', data: 'm:new' }]]);
    await reply(
      ctx,
      'Meine Handelsfälle:',
      trades.map((t) => [{ text: `#${t.id} · ${t.title.slice(0, 24)} · ${STATE_LABEL_DE[t.status]}`, data: `t:${t.id}:view` }]),
    );
  }

  async function startNewTrade(ctx: Context, userId: number) {
    await setFlow(db, userId, { flow: 'newtrade', step: 'title', data: {} }, svc.now());
    await reply(ctx, 'Neuer Handel – Schritt 1/6\nTitel des Handels (max. 80 Zeichen):\n\n(/cancel bricht ab)');
  }

  async function showInvites(ctx: Context, userId: number, tradeId: string) {
    const invites = await listInvites(svc, userId, tradeId);
    const rows = [
      [{ text: 'Käufer einladen', data: `i:${tradeId}:buyer` }, { text: 'Verkäufer einladen', data: `i:${tradeId}:seller` }],
      [{ text: 'Schlichter einladen', data: `i:${tradeId}:arbiter` }],
      [{ text: 'Vermittler einladen', data: `i:${tradeId}:mediator` }, { text: 'Beobachter einladen', data: `i:${tradeId}:observer` }],
      ...invites.map((i) => [{ text: `Widerrufen: ${ROLE_LABEL_DE[i.role]} (#${i.id})`, data: `r:${tradeId}:${i.id}` }]),
    ];
    await reply(ctx, `Einladungen für #${tradeId}\nAktive Einladungen: ${invites.length}`, rows);
  }

  // ---------- commands ----------

  bot.command('start', (ctx) =>
    guard(ctx, async () => {
      const userId = ctx.from!.id;
      const payload = ctx.match.trim();
      if (payload.startsWith('i_')) {
        const r = await startRedeem(svc, userId, payload.slice(2));
        await setFlow(db, userId, { flow: 'invite_code', step: 'code', data: { inviteId: r.inviteId } }, svc.now());
        await reply(
          ctx,
          `Einladung zu Handel #${r.tradeId} als ${ROLE_LABEL_DE[r.role]}.\n\nBitte den Zugangscode eingeben, den du separat vom Einladenden erhalten hast.\n\n` +
            'Hinweis: Diese Einladung ist jetzt an dein Telegram-Konto gebunden.',
        );
        return;
      }
      await showMenu(ctx);
    }),
  );
  bot.command('help', (ctx) => reply(ctx, HELP_TEXT, [[{ text: 'Sicherheitsinformationen', data: 'm:security' }]]));
  bot.command('privacy', (ctx) => reply(ctx, privacyText(svc.cfg)));
  bot.command('fees', (ctx) => reply(ctx, feesText(svc.cfg)));
  bot.command('support', (ctx) => reply(ctx, 'Support', supportMenu(svc.cfg)));
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
  async function showDisputes(ctx: Context, userId: number) {
    const ds = await listOpenDisputes(svc, userId);
    if (ds.length === 0) return void (await reply(ctx, `Keine offenen Streitfälle.\n\n${DISPUTE_LIMITS_TEXT}`, [[{ text: 'Support', url: svc.cfg.supportUrl }]]));
    await reply(ctx, 'Offene Streitfälle:', ds.map((d) => [{ text: `#${d.trade_id} · ${d.status}`, data: `t:${d.trade_id}:view` }]));
  }
  bot.command('disputes', (ctx) => guard(ctx, () => showDisputes(ctx, ctx.from!.id)));
  bot.command('status', (ctx) =>
    guard(ctx, async () => {
      const id = ctx.match.trim().replace(/^#/, '').toUpperCase();
      if (TRADE_ID_RE.test(id)) {
        const a = await authorize(svc, ctx.from!.id, id, 'view_trade');
        // status only – safe for groups
        return void (await reply(ctx, `Handel #${id}: ${STATE_LABEL_DE[a.trade.status]}`));
      }
      await reply(ctx, `Bot aktiv. Netzwerk: ${svc.net.name}. Mainnet: ${svc.net.name === 'mainnet' ? 'aktiv' : 'gesperrt'}.`);
    }),
  );
  bot.command('link', (ctx) =>
    guard(ctx, async () => {
      const id = ctx.match.trim().replace(/^#/, '').toUpperCase();
      if (!TRADE_ID_RE.test(id) || !ctx.chat) return void (await reply(ctx, 'Nutzung in der Gruppe: /link <ID>'));
      await linkGroup(svc, ctx.from!.id, id, ctx.chat.id);
      await reply(ctx, `Gruppe mit Handel #${id} verknüpft. Hier erscheinen nur Statusmeldungen – keine Adressen, Schlüssel oder Zahlungsdaten.\n\n${privacyText(svc.cfg)}`);
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
          case 'new': return startNewTrade(ctx, userId);
          case 'trades': case 'invites': return void (await showTrades(ctx, userId));
          case 'disputes': return showDisputes(ctx, userId);
          case 'fees': return void (await reply(ctx, feesText(svc.cfg)));
          case 'help': return void (await reply(ctx, HELP_TEXT, [[{ text: 'Sicherheitsinformationen', data: 'm:security' }]]));
          case 'support': return void (await reply(ctx, 'Support', supportMenu(svc.cfg)));
          case 'security': return void (await reply(ctx, securityText()));
          default: return showMenu(ctx);
        }
      }

      if ((m = /^n:role:(buyer|seller)$/.exec(data))) return onNewTradeRole(ctx, userId, m[1] as 'buyer' | 'seller');
      if (data === 'n:confirm') return onNewTradeConfirm(ctx, userId);

      if ((m = /^i:([A-Z0-9]{8}):([a-z]+)$/.exec(data))) {
        if (!isRole(m[2]!)) return;
        const inv = await createInvite(svc, userId, m[1]!, m[2] as Role);
        await reply(
          ctx,
          `Einladung als ${ROLE_LABEL_DE[inv.role]} für #${m[1]} (gültig 72 h, einmalig):\n\n${inv.link}\n\n` +
            `Zugangscode: ${inv.accessCode}\n\n` +
            'Sende Link und Code auf GETRENNTEN Wegen (z. B. Code per verschlüsseltem Einmal-Link über ' +
            `${svc.cfg.cryptgeonUrl}). Der Link wird beim ersten Öffnen an dieses Telegram-Konto gebunden.`,
        );
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
        const rows =
          a.trade.status === 'AGREEMENT' && a.participant && a.participant.agreed_hash !== a.trade.agreement_hash && (a.role === 'buyer' || a.role === 'seller' || a.role === 'arbiter')
            ? [[{ text: 'Bedingungen akzeptieren', data: `t:${tradeId}:agree:${a.trade.agreement_hash!.slice(0, 16)}` }]]
            : undefined;
        return void (await reply(ctx, termsView(a.trade), rows));
      }
      case 'agree':
        return send(await agreeTerms(svc, userId, tradeId, arg ?? ''));
      case 'parts': {
        await authorize(svc, userId, tradeId, 'view_participants');
        const parts = await listParticipants(db, tradeId);
        // no usernames/ids exposed: roles and status only
        return void (await reply(ctx, `Teilnehmer #${tradeId}:\n` + parts.map((p) => `• ${ROLE_LABEL_DE[p.role]}${p.telegram_user_id === userId ? ' (du)' : ''}`).join('\n')));
      }
      case 'fees':
        await authorize(svc, userId, tradeId, 'view_trade');
        return void (await reply(ctx, feesText(svc.cfg)));
      case 'pay':
        return showPayment(ctx, userId, tradeId);
      case 'inv':
        return showInvites(ctx, userId, tradeId);
      case 'key': {
        const a = await authorize(svc, userId, tradeId, 'register_key');
        const ms = await getMultisig(db, tradeId);
        if (ms) {
          return void (await reply(ctx, verificationText(ms, tradeId), [
            [{ text: 'Adresse stimmt überein', data: `t:${tradeId}:verify:${ms.address.slice(-8)}` }],
            [{ text: 'Stimmt NICHT', data: `t:${tradeId}:verifyfail` }],
          ]));
        }
        if (a.trade.status !== 'KEY_SETUP') throw new UserError('Jetzt keine Schlüsselregistrierung.');
        await setFlow(db, userId, { flow: 'key', step: 'key', data: { tradeId } }, svc.now());
        return void (await reply(
          ctx,
          `Sende jetzt deinen öffentlichen Multisig-Schlüssel für #${tradeId}:\n\n[fingerprint/48h/${svc.net.coinType}h/<konto>h/2h]tpub…\n\n` +
            'Sparrow: Neue Wallet → Multisig → Keystore „Watch-only/xPub“ → Key-Origin und tpub kopieren. ' +
            'Nutze ein NEUES Konto nur für diesen Handel. NIEMALS Seed oder tprv senden!',
        ));
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
        return void (await reply(ctx, `Sende jetzt deine ${svc.net.name}-Empfangsadresse für #${tradeId} (nur hier privat).`));
      case 'cancel':
        return void (await reply(ctx, `Handel #${tradeId} wirklich abbrechen?`, [[{ text: 'Ja, abbrechen', data: `t:${tradeId}:cancelok` }]]));
      case 'cancelok':
        await send(await cancelTrade(svc, userId, tradeId));
        return void (await reply(ctx, `Handel #${tradeId} abgebrochen.`));
      case 'dispute': {
        const a = await authorize(svc, userId, tradeId, 'view_trade');
        const can = a.role === 'buyer' || a.role === 'seller';
        if (!can) return void (await reply(ctx, 'Streitfälle eröffnen Käufer oder Verkäufer. Support:', supportMenu(svc.cfg)));
        if (await getOpenDispute(db, tradeId)) return void (await reply(ctx, 'Es gibt bereits einen offenen Streitfall.', [[{ text: 'Stellungnahme senden', data: `d:${tradeId}:ask` }]]));
        await setFlow(db, userId, { flow: 'dispute', step: 'reason', data: { tradeId } }, svc.now());
        return void (await reply(ctx, `Probleme mit Handel #${tradeId}\n\n${DISPUTE_LIMITS_TEXT}\n\nBitte beschreibe das Problem (keine privaten Daten, ggf. Cryptgeon-Link):`));
      }
    }
  }

  async function showPayment(ctx: Context, userId: number, tradeId: string) {
    const a = await authorize(svc, userId, tradeId, 'view_trade');
    const ms = await getMultisig(db, tradeId);
    const funding = await listFunding(db, tradeId);
    let text = `Zahlungsstatus #${tradeId}: ${STATE_LABEL_DE[a.trade.status]}\nErwartet: ${formatBtc(BigInt(a.trade.amount_sats))} BTC`;
    const seen = funding.filter((f) => f.status === 'confirmed' || f.status === 'unconfirmed');
    text += `\nGesehene Einzahlungen: ${seen.length} (Summe ${formatBtc(seen.reduce((s, f) => s + BigInt(f.value_sats), 0n))} BTC, bestätigt: ${seen.filter((f) => f.status === 'confirmed').length})`;
    // address only for signing parties, only in private chat
    const signer = a.role === 'buyer' || a.role === 'seller' || a.role === 'arbiter';
    if (ms && signer && ctx.chat?.type === 'private') text += `\n\nTreuhandadresse:\n${ms.address}`;
    await reply(ctx, text);
  }

  async function onSessionAction(ctx: Context, userId: number, sessionId: string, action: string) {
    const session = await getSession(db, sessionId);
    if (!session) throw new UserError('Session nicht gefunden.');
    const a = await authorize(svc, userId, session.trade_id, 'sign_psbt');
    if (action === 'up') {
      await setFlow(db, userId, { flow: 'psbt', step: 'psbt', data: { sessionId } }, svc.now());
      return void (await reply(ctx, 'Sende jetzt die in deiner Wallet signierte PSBT (Base64-Text oder .psbt-Datei).'));
    }
    if (action === 'show') {
      const text = sessionSummary(a.trade, session, svc.net.name);
      await reply(ctx, text);
      return deliver(bot.api, svc, [{ chatId: userId, text: 'PSBT-Datei:', document: { filename: `trade-${a.trade.id}-${session.id}.psbt`, content: session.base_psbt } }]);
    }
    return send(await broadcastSession(svc, userId, sessionId));
  }

  async function onDisputeAction(ctx: Context, userId: number, tradeId: string, action: string) {
    if (action === 'take') {
      const t = await getTrade(db, tradeId);
      if (t?.status === 'ARBITRATION') {
        await authorize(svc, userId, tradeId, 'decide_dispute');
        const d = await getOpenDispute(db, tradeId);
        return void (await reply(ctx, d ? disputeText(d) : 'Kein Streitfall', [
          [{ text: 'Release an Verkäufer', data: `d:${tradeId}:release` }],
          [{ text: 'Refund an Käufer', data: `d:${tradeId}:refund` }],
          [{ text: 'Rückfrage an Parteien', data: `d:${tradeId}:ask` }],
        ]));
      }
      return send(await takeCase(svc, userId, tradeId));
    }
    if (action === 'ask') {
      await authorize(svc, userId, tradeId, 'view_dispute');
      await setFlow(db, userId, { flow: 'dnote', step: 'note', data: { tradeId } }, svc.now());
      return void (await reply(ctx, 'Nachricht zum Streitfall eingeben (wird an Käufer, Verkäufer und Schlichter weitergegeben, keine privaten Daten):'));
    }
    await authorize(svc, userId, tradeId, 'decide_dispute');
    await setFlow(db, userId, { flow: 'decide', step: 'note', data: { tradeId, decision: action as 'release' | 'refund' } }, svc.now());
    await reply(ctx, `Entscheidung „${action === 'release' ? 'Release an Verkäufer' : 'Refund an Käufer'}“ – bitte Begründung eingeben (wird dokumentiert):`);
  }

  async function onNewTradeRole(ctx: Context, userId: number, role: 'buyer' | 'seller') {
    const f = await getFlow(db, userId, svc.now());
    if (!f || f.flow !== 'newtrade' || f.step !== 'role') throw new UserError('Kein aktiver Dialog. /newtrade');
    const d = { ...f.data, role };
    await setFlow(db, userId, { flow: 'newtrade', step: 'confirm', data: d }, svc.now());
    await reply(
      ctx,
      'Zusammenfassung – bitte prüfen:\n\n' +
        `Titel: ${d.title}\nBeschreibung: ${d.description}\nBetrag: ${formatBtc(BigInt(d.amountSats!))} BTC\nBedingungen: ${d.terms}\n` +
        `Deine Rolle: ${ROLE_LABEL_DE[role]}\n\n${feesText(svc.cfg)}\n\nMit „Erstellen“ akzeptierst du dieses Gebührenmodell.`,
      [[{ text: 'Erstellen', data: 'n:confirm' }], [{ text: 'Abbrechen', data: 'm:menu' }]],
    );
  }

  async function onNewTradeConfirm(ctx: Context, userId: number) {
    const f = await getFlow(db, userId, svc.now());
    if (!f || f.flow !== 'newtrade' || f.step !== 'confirm') throw new UserError('Kein aktiver Dialog. /newtrade');
    const d = f.data;
    const t = await createTrade(svc, userId, {
      title: d.title!, description: d.description!, terms: d.terms!, amountSats: BigInt(d.amountSats!), creatorRole: d.role!,
    });
    await clearFlow(db, userId);
    await reply(ctx, `Handel #${t.id} erstellt. Lade jetzt die anderen Parteien ein (Käufer/Verkäufer und ein unabhängiger Schlichter).`, [
      [{ text: 'Einladungen erstellen', data: `t:${t.id}:inv` }],
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
          return void (await reply(ctx, 'Schritt 2/6 – Beschreibung (keine persönlichen Daten):'));
        }
        if (f.step === 'description') {
          d.description = text.slice(0, 2000);
          await setFlow(db, userId, { flow: 'newtrade', step: 'amount', data: d }, now);
          return void (await reply(ctx, 'Schritt 3/6 – BTC-Betrag (z. B. 0,01 oder 1000000 sat):'));
        }
        if (f.step === 'amount') {
          d.amountSats = parseBtcAmount(text).toString();
          await setFlow(db, userId, { flow: 'newtrade', step: 'terms', data: d }, now);
          return void (await reply(ctx, `Betrag: ${formatBtc(BigInt(d.amountSats))} BTC\n\nSchritt 4/6 – Handelsbedingungen (Lieferung, Fristen, Rückgabe):`));
        }
        if (f.step === 'terms') {
          d.terms = text.slice(0, 4000);
          await setFlow(db, userId, { flow: 'newtrade', step: 'role', data: d }, now);
          return void (await reply(ctx, 'Schritt 5/6 – Deine Rolle:', [[{ text: 'Ich bin Käufer', data: 'n:role:buyer' }, { text: 'Ich bin Verkäufer', data: 'n:role:seller' }]]));
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
          await setFlow(db, userId, { flow: 'dispute', step: 'links', data: { tradeId: f.data.tradeId, reason: text.slice(0, 3000) } }, now);
          return void (await reply(ctx, 'Optional: externe Beweislinks (https, durch Leerzeichen getrennt) – oder „-“ für keine:'));
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

  bot.on('message', (ctx) => reply(ctx, MAIN_MENU_TEXT, mainMenu()));

  return bot;
}
