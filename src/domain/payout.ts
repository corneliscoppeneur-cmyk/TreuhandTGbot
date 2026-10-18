import { base64, hex } from '@scure/base';
import { PSBT_SESSION_TTL_SECONDS, TELEGRAM_MAX_MESSAGE_CHARS } from '../config/constants.ts';
import { pickFeeRate } from '../bitcoin/fee-estimator.ts';
import { addressToScript, AddressError } from '../bitcoin/networks.ts';
import {
  buildPsbt,
  combineAndFinalize,
  planPayout,
  PsbtError,
  type FundingUtxo,
  type PayoutKind,
  type PayoutOutput,
} from '../bitcoin/psbt.ts';
import { mergeSignatures, verifyPsbtSignatures } from '../bitcoin/psbt-validator.ts';
import { ProviderError } from '../blockchain/provider.ts';
import {
  auditStmt,
  getMultisig,
  getOpenDispute,
  getSession,
  getTrade,
  listFunding,
  listParticipants,
  transition,
  type SessionRow,
  type TradeRow,
} from '../database/repo.ts';
import { newSessionId } from '../security/tokens.ts';
import { logError } from '../security/redaction.ts';
import { formatBtc, formatSats } from './amount.ts';
import type { MessageContent, Notice, ServiceCtx } from './context.ts';
import { b, code, esc, explorerTxUrl, i, pre, table, time, toPlain } from '../telegram/format.ts';
import { UserError } from './context.ts';
import { commissionSats, formatBps } from './fees.ts';
import { escrowFromRow } from './keys.ts';
import { ROLE_LABEL_DE } from './permissions.ts';
import { authorize, groupNotice, isSigningRole, signerIds } from './trade.ts';
import { isOperator } from './operator.ts';

export const RECIPIENT_ROLE: Record<PayoutKind, 'buyer' | 'seller'> = { release: 'seller', refund: 'buyer' };

export async function markDelivered(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'mark_delivered');
  if (a.trade.status !== 'FUNDED') throw new UserError('Lieferung kann nur nach bestätigter Finanzierung gemeldet werden.');
  await transition(ctx.db, {
    tradeId,
    from: 'FUNDED',
    to: 'FULFILLMENT',
    expectedVersion: a.trade.version,
    actorId: userId,
    action: 'delivered',
    now: ctx.now(),
  });
  const s = signerIds(await listParticipants(ctx.db, tradeId));
  return [
    {
      chatId: s.buyer!,
      text: `📦 Handel #${tradeId}: Der Verkäufer hat die Lieferung gemeldet.

Bitte prüfe die Ware. Ist alles in Ordnung, gib die Zahlung frei. Gibt es ein Problem, tippe auf „Probleme mit Admin“ – dann wird nichts ausgezahlt, bis der Schlichter entschieden hat.`,
      buttons: [
        [{ text: '✅ Freigabe an Verkäufer', data: `t:${tradeId}:release`, style: 'success' as const }],
        [{ text: 'Probleme mit Admin', data: `t:${tradeId}:dispute`, style: 'danger' as const }],
      ],
    },
    ...groupNotice(a.trade, 'LIEFERUNG GEMELDET'),
  ];
}

async function requestPayout(ctx: ServiceCtx, userId: number, tradeId: string, kind: PayoutKind): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, kind === 'release' ? 'request_release' : 'request_refund');
  if (a.trade.status !== 'FUNDED' && a.trade.status !== 'FULFILLMENT') throw new UserError('Jetzt nicht möglich.');
  const to = kind === 'release' ? 'RELEASE_REQUESTED' : 'REFUND_REQUESTED';
  await transition(ctx.db, {
    tradeId,
    from: a.trade.status,
    to,
    expectedVersion: a.trade.version,
    actorId: userId,
    action: `${kind}_requested`,
    now: ctx.now(),
  });
  return askRecipientAddress(ctx, a.trade, kind);
}

export function requestRelease(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  return requestPayout(ctx, userId, tradeId, 'release');
}

export function requestRefund(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  return requestPayout(ctx, userId, tradeId, 'refund');
}

export async function askRecipientAddress(ctx: ServiceCtx, trade: TradeRow, kind: PayoutKind): Promise<Notice[]> {
  const s = signerIds(await listParticipants(ctx.db, trade.id));
  const recipient = s[RECIPIENT_ROLE[kind]]!;
  const label = kind === 'release' ? 'Auszahlung' : 'Rückerstattung';
  return [
    {
      chatId: recipient,
      text: `📥 Handel #${trade.id}: ${label} wird vorbereitet.

Wohin soll das Geld? Bitte gib eine Empfangsadresse aus deiner Wallet an (in Sparrow: Reiter „Receive“).${ctx.net.name === 'signet' ? ' Für den Test eine Signet-Adresse (beginnt mit tb1).' : ''}`,
      buttons: [[{ text: '📥 Empfangsadresse angeben', data: `t:${trade.id}:addr`, style: 'primary' as const }]],
    },
    ...[s.buyer, s.seller, s.arbiter]
      .filter((id): id is number => id !== undefined && id !== recipient && !isOperator(ctx, id))
      .map((chatId) => ({
        chatId,
        text: `⏳ Handel #${trade.id}: ${label} angefordert. Sobald der Empfänger seine Adresse angibt, bekommst du die Auszahlung zum Unterschreiben.`,
      })),
    ...groupNotice(trade, kind === 'release' ? 'FREIGABE ANGEFORDERT' : 'RÜCKERSTATTUNG ANGEFORDERT'),
  ];
}

function payoutKindForStatus(status: string): PayoutKind | null {
  if (status === 'RELEASE_REQUESTED') return 'release';
  if (status === 'REFUND_REQUESTED') return 'refund';
  return null;
}

/** PSBT session summary as rich message (table of outputs, addresses, txid, expiry). */
export function sessionSummary(trade: TradeRow, session: SessionRow, netName: 'signet' | 'mainnet', expected?: string): MessageContent {
  const outs = JSON.parse(session.outputs_json) as { purpose: PayoutOutput['purpose']; address: string; valueSats: string }[];
  const utxos = JSON.parse(session.utxos_json) as { txid: string; vout: number; valueSats: string }[];
  const total = utxos.reduce((s, u) => s + BigInt(u.valueSats), 0n);
  const rows = [
    ['Ausgang', 'Betrag', 'Adresse'],
    ...outs.map((o) => [
      o.purpose === 'recipient' ? 'Empfänger' : 'Provision Betreiber',
      `${b(esc(formatBtc(BigInt(o.valueSats))))} BTC`,
      code(o.address),
    ]),
    ['Netzwerkgebühr', `${esc(formatSats(BigInt(session.miner_fee_sats)))} (${esc(session.fee_rate)} sat/vB)`, '–'],
  ];
  const markup =
    `<h3>${session.kind === 'release' ? '✅ AUSZAHLUNG an Verkäufer' : '↩️ RÜCKERSTATTUNG an Käufer'} · #${esc(trade.id)}</h3>` +
    `<p>Netzwerk: ${esc(netName)} · Session ${code(session.id)} · gültig bis ${time(session.expires_at, 'dt')}</p>` +
    `<p>Eingänge: ${utxos.length} UTXO, gesamt ${b(esc(formatBtc(total)))} BTC</p>` +
    table(rows) +
    `<p>txid: ${code(session.txid)}</p>` +
    (expected ? `<p>Erwartete Signaturen: ${b(esc(expected))} (2 von 3)</p>` : '') +
    `<blockquote>Prüfe in deiner Wallet, dass Beträge und Adressen EXAKT übereinstimmen, bevor du signierst. ` +
    'Jede Änderung erfordert eine neue Session. Nur SIGHASH_ALL.</blockquote>';
  return { text: toPlain(markup), rich: markup };
}

/** Recipient submits payout address → PSBT session is built (RELEASE/REFUND_REQUESTED → SIGNING). */
export async function submitPayoutAddress(ctx: ServiceCtx, userId: number, tradeId: string, address: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'view_payment_details');
  const kind = payoutKindForStatus(a.trade.status);
  if (!kind) throw new UserError('Jetzt wird keine Empfangsadresse benötigt.');
  if (a.role !== RECIPIENT_ROLE[kind]) throw new UserError(`Die Empfangsadresse gibt der ${ROLE_LABEL_DE[RECIPIENT_ROLE[kind]]} an.`);
  if (await getOpenDispute(ctx.db, tradeId)) throw new UserError('Offener Streitfall: Auszahlung gesperrt.');

  const ms = await getMultisig(ctx.db, tradeId);
  if (!ms) throw new Error('multisig missing');
  try {
    addressToScript(address, ctx.net);
  } catch (e) {
    throw new UserError(e instanceof AddressError ? e.message : 'Adresse ungültig');
  }
  if (address.trim() === ms.address) throw new UserError('Das ist die Treuhandadresse selbst.');

  const funding = (await listFunding(ctx.db, tradeId)).filter((f) => f.status === 'confirmed');
  const utxos: FundingUtxo[] = funding.map((f) => ({ txid: f.txid, vout: f.vout, valueSats: BigInt(f.value_sats) }));
  if (utxos.reduce((s, u) => s + u.valueSats, 0n) !== BigInt(a.trade.amount_sats)) {
    throw new UserError('Finanzierungsdaten inkonsistent. Handel wird geprüft.');
  }

  let feeRate: number;
  try {
    feeRate = pickFeeRate(await ctx.chain.getFeeEstimates(), 6);
  } catch {
    throw new UserError('Gebührenschätzung derzeit nicht verfügbar. Bitte später erneut versuchen.');
  }

  const amount = BigInt(a.trade.amount_sats);
  let plan;
  try {
    plan = planPayout({
      kind,
      utxos,
      amountSats: amount,
      recipientAddress: address,
      // fee already paid upfront at deposit → no commission output in the payout
      commissionSats:
        a.trade.fee_sats > 0 ? 0n : commissionSats(amount, kind === 'release' ? a.trade.commission_bps : a.trade.refund_commission_bps),
      commissionAddress: ctx.cfg.commissionAddress,
      feeRateSatVb: feeRate,
      maxFeeRateSatVb: ctx.cfg.maxFeeRateSatVb,
      maxFeePercent: ctx.cfg.maxFeePercent,
      net: ctx.net,
    });
  } catch (e) {
    throw new UserError(e instanceof PsbtError ? `PSBT nicht erstellt: ${e.message}` : 'PSBT nicht erstellt');
  }
  const built = buildPsbt(plan, escrowFromRow(ms));
  const now = ctx.now();
  const id = newSessionId();
  const ser = (v: bigint) => v.toString();
  await transition(ctx.db, {
    tradeId,
    from: a.trade.status,
    to: 'SIGNING',
    expectedVersion: a.trade.version,
    actorId: userId,
    action: 'psbt_created',
    detail: id,
    now,
    followUps: (g, gp) => [
      ctx.db
        .prepare(
          `INSERT INTO psbt_sessions (id, trade_id, kind, status, base_psbt, unsigned_tx_hex, txid, utxos_json, outputs_json,
             miner_fee_sats, fee_rate, created_by, created_at, expires_at, updated_at)
           SELECT ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${g}`,
        )
        .bind(
          id,
          tradeId,
          kind,
          built.psbtBase64,
          built.unsignedTxHex,
          built.txid,
          JSON.stringify(utxos.map((u) => ({ txid: u.txid, vout: u.vout, valueSats: ser(u.valueSats) }))),
          JSON.stringify(plan.outputs.map((o) => ({ purpose: o.purpose, address: o.address, valueSats: ser(o.valueSats) }))),
          Number(plan.minerFeeSats),
          plan.feeRateSatVb,
          userId,
          now,
          now + PSBT_SESSION_TTL_SECONDS,
          now,
          ...gp,
        ),
    ],
  });
  const session = (await getSession(ctx.db, id))!;
  return psbtNotices(ctx, a.trade, session);
}

/** After an arbiter decision the arbiter signs; otherwise buyer + seller sign and the operator is not bothered. */
async function hasResolvedDispute(ctx: ServiceCtx, tradeId: string): Promise<boolean> {
  return (
    (await ctx.db.prepare(`SELECT 1 AS x FROM disputes WHERE trade_id = ? AND status = 'resolved' LIMIT 1`).bind(tradeId).first()) !== null
  );
}

/** Signing parties to inform about a payout; the operator-arbiter only when a dispute decided the payout. */
function payoutChats(ctx: ServiceCtx, ids: (number | undefined)[], disputed: boolean): number[] {
  return ids.filter((x): x is number => x !== undefined && (disputed || !isOperator(ctx, x)));
}

async function psbtNotices(ctx: ServiceCtx, trade: TradeRow, session: SessionRow): Promise<Notice[]> {
  const s = signerIds(await listParticipants(ctx.db, trade.id));
  const disputed = await hasResolvedDispute(ctx, trade.id);
  const expected = disputed ? `${ROLE_LABEL_DE[RECIPIENT_ROLE[session.kind]]} + Schlichter` : 'Käufer + Verkäufer';
  const summary = sessionSummary(trade, session, ctx.net.name, expected);
  const inline = session.base_psbt.length < TELEGRAM_MAX_MESSAGE_CHARS - 300;
  const buttons = [
    [{ text: '✍️ Signierte PSBT hochladen', data: `s:${session.id}:up`, style: 'primary' as const }],
    [{ text: '📋 txid kopieren', copy: session.txid }],
  ];
  return payoutChats(ctx, [s.buyer, s.seller, s.arbiter], disputed).flatMap((chatId) => [
    { chatId, ...summary },
    {
      chatId,
      // PSBT as tap-to-copy code block (if short) plus as .psbt file for the wallet
      ...(inline
        ? {
            text: `${signGuide().text}\n\n${session.base_psbt}`,
            html: `${signGuide().html}\n\n${b('Auszahlungs-Entwurf als Text')} (antippen = kopieren):\n${pre(session.base_psbt)}`,
          }
        : signGuide()),
      document: { filename: `trade-${trade.id}-${session.id}.psbt`, content: session.base_psbt },
      buttons,
    },
  ]);
}

/** Imports a signed PSBT: full re-validation, store signatures, finalize when 2 of 3 are present. */
export async function submitSignedPsbt(ctx: ServiceCtx, userId: number, sessionId: string, psbt: Uint8Array): Promise<Notice[]> {
  const session = await getSession(ctx.db, sessionId);
  if (!session) throw new UserError('Signatur-Session nicht gefunden.');
  const a = await authorize(ctx, userId, session.trade_id, 'sign_psbt');
  if (!isSigningRole(a.role)) throw new UserError('Keine Signaturberechtigung.');
  if (session.status === 'locked') throw new UserError('Session gesperrt (Streitfall). Keine botseitige Auszahlung.');
  if (session.status !== 'open') throw new UserError('Session ist nicht mehr offen.');
  if (session.expires_at <= ctx.now()) throw new UserError('Session abgelaufen. Bitte neue Session anfordern.');
  if (a.trade.status !== 'SIGNING') throw new UserError('Handel ist nicht im Signaturstatus.');

  const ms = (await getMultisig(ctx.db, session.trade_id))!;
  const escrow = escrowFromRow(ms);
  const utxos = (JSON.parse(session.utxos_json) as { txid: string; vout: number; valueSats: string }[]).map((u) => ({
    txid: u.txid,
    vout: u.vout,
    valueSats: BigInt(u.valueSats),
  }));
  const ref = { unsignedTxHex: session.unsigned_tx_hex, utxos };

  let verified;
  try {
    verified = verifyPsbtSignatures(psbt, escrow, ref);
  } catch (e) {
    await auditStmt(ctx.db, {
      tradeId: session.trade_id,
      actorId: userId,
      action: 'psbt_rejected',
      detail: e instanceof PsbtError ? e.message : 'invalid',
      now: ctx.now(),
    }).run();
    throw new UserError(e instanceof PsbtError ? `PSBT abgelehnt: ${e.message}` : 'PSBT abgelehnt');
  }
  if (verified.perInput.every((m) => m.size === 0)) throw new UserError('PSBT enthält keine Signatur.');

  const now = ctx.now();
  const stmts = escrow.signers
    .filter((sg) => verified.roles.has(sg.role))
    .map((sg) =>
      ctx.db
        .prepare('INSERT OR IGNORE INTO psbt_signatures (session_id, role, telegram_user_id, sigs_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(session.id, sg.role, userId, JSON.stringify(verified.perInput.map((m) => hex.encode(m.get(hex.encode(sg.pubkey))!))), now),
    );
  if (stmts.length === 0) throw new UserError('Signaturen unvollständig (nicht alle Inputs signiert).');
  await ctx.db.batch([
    ...stmts,
    auditStmt(ctx.db, {
      tradeId: session.trade_id,
      actorId: userId,
      action: 'psbt_signature_imported',
      detail: [...verified.roles].join(','),
      now,
    }),
  ]);

  const stored = await ctx.db
    .prepare('SELECT COUNT(*) AS n FROM psbt_signatures WHERE session_id = ?')
    .bind(session.id)
    .first<{ n: number }>();
  const parts = await listParticipants(ctx.db, session.trade_id);
  const signerChats = payoutChats(
    ctx,
    parts.filter((p) => isSigningRole(p.role)).map((p) => p.telegram_user_id),
    await hasResolvedDispute(ctx, session.trade_id),
  );
  const who = [...verified.roles].map((r) => ROLE_LABEL_DE[r]).join(', ');
  if ((stored?.n ?? 0) < 2) {
    return signerChats.map((chatId) => ({
      chatId,
      text: `✍️ Handel #${session.trade_id}: Unterschrift von ${who} ist eingegangen und geprüft. Es fehlt noch eine zweite Unterschrift.`,
    }));
  }
  // Finalization runs in a separate request (send button / cron) to keep each Worker invocation's CPU time low.
  if (ctx.cfg.automaticBroadcast) {
    await ctx.db.prepare('UPDATE scheduled_jobs SET next_poll_at = ? WHERE trade_id = ?').bind(now, session.trade_id).run();
  }
  return signerChats.map((chatId) => ({
    chatId,
    text:
      `✍️ Handel #${session.trade_id}: Unterschrift von ${who} ist eingegangen. Damit liegen 2 gültige Unterschriften vor.` +
      (ctx.cfg.automaticBroadcast
        ? ' Die Auszahlung wird automatisch gesendet.'
        : ' Tippe auf „Transaktion senden“, um die Auszahlung abzuschicken.'),
    ...(ctx.cfg.automaticBroadcast
      ? {}
      : { buttons: [[{ text: '🚀 Transaktion senden', data: `s:${session.id}:bc`, style: 'success' as const }]] }),
  }));
}

/** Combines the stored (already validated) signatures, finalizes and stores the raw transaction. */
export async function finalizeSession(ctx: ServiceCtx, session: SessionRow): Promise<SessionRow> {
  if (session.status === 'finalized') return session;
  if (session.status !== 'open') throw new UserError('Session ist nicht offen.');
  const ms = (await getMultisig(ctx.db, session.trade_id))!;
  const escrow = escrowFromRow(ms);
  const utxos = (JSON.parse(session.utxos_json) as { txid: string; vout: number; valueSats: string }[]).map((u) => ({
    txid: u.txid,
    vout: u.vout,
    valueSats: BigInt(u.valueSats),
  }));
  const stored = (
    await ctx.db
      .prepare('SELECT role, sigs_json FROM psbt_signatures WHERE session_id = ?')
      .bind(session.id)
      .all<{ role: string; sigs_json: string }>()
  ).results;
  if (stored.length < 2) throw new UserError('Es fehlen Signaturen (2 von 3 erforderlich).');
  let merged: Map<string, Uint8Array>[] = utxos.map(() => new Map());
  for (const row of stored) {
    const signer = escrow.signers.find((sg) => sg.role === row.role)!;
    const sigs = JSON.parse(row.sigs_json) as string[];
    merged = mergeSignatures(
      merged,
      sigs.map((sig) => new Map([[hex.encode(signer.pubkey), hex.decode(sig)]])),
    );
  }
  const final = combineAndFinalize(session.base_psbt, merged, escrow, { unsignedTxHex: session.unsigned_tx_hex, utxos });
  if (final.txid !== session.txid) throw new Error('txid mismatch after finalize');
  const now = ctx.now();
  const fin = await ctx.db
    .prepare(`UPDATE psbt_sessions SET status = 'finalized', raw_tx_hex = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
    .bind(final.rawTxHex, now, session.id)
    .run();
  if (fin.meta.changes === 1)
    await auditStmt(ctx.db, { tradeId: session.trade_id, actorId: 0, action: 'psbt_finalized', detail: session.txid, now }).run();
  return (await getSession(ctx.db, session.id))!;
}

/** Broadcasts a finalized session. actorId 0 = system. Idempotent. */
export async function broadcastSession(ctx: ServiceCtx, actorId: number, sessionId: string): Promise<Notice[]> {
  const session = await getSession(ctx.db, sessionId);
  if (!session) throw new UserError('Session nicht gefunden.');
  if (actorId !== 0) {
    const a = await authorize(ctx, actorId, session.trade_id, 'sign_psbt');
    if (!isSigningRole(a.role)) throw new UserError('Keine Berechtigung.');
  }
  if (session.status === 'broadcast' || session.status === 'confirmed') return [];
  if (session.status === 'locked') throw new UserError('Session gesperrt (Streitfall). Kein Senden durch den Bot.');
  const trade = (await getTrade(ctx.db, session.trade_id))!;
  if (trade.status !== 'SIGNING') throw new UserError('Senden in diesem Status nicht erlaubt.');
  if (await getOpenDispute(ctx.db, trade.id)) throw new UserError('Offener Streitfall: kein Senden durch den Bot.');
  const ready = await finalizeSession(ctx, session);
  if (!ready.raw_tx_hex) throw new UserError('Transaktion ist nicht bereit.');

  const now = ctx.now();
  let txid: string;
  try {
    txid = await ctx.chain.broadcast(ready.raw_tx_hex);
  } catch (e) {
    logError('broadcast', e);
    if (e instanceof ProviderError && e.kind === 'rejected') {
      await transition(ctx.db, {
        tradeId: trade.id,
        from: 'SIGNING',
        to: 'NEEDS_REVIEW',
        expectedVersion: trade.version,
        actorId,
        action: 'broadcast_rejected',
        now,
        detail: e.message.slice(0, 200),
        set: { sql: 'review_reason = ?', params: ['Broadcast vom Netzwerk abgelehnt'] },
        followUps: (g, gp) => [
          ctx.db.prepare(`UPDATE psbt_sessions SET status = 'failed', updated_at = ? WHERE id = ? AND ${g}`).bind(now, session.id, ...gp),
        ],
      });
      return [];
    }
    throw new UserError('Senden derzeit nicht möglich (API-Fehler). Bitte später erneut versuchen.');
  }
  if (txid !== session.txid) throw new Error('broadcast txid mismatch');
  await transition(ctx.db, {
    tradeId: trade.id,
    from: 'SIGNING',
    to: 'BROADCAST',
    expectedVersion: trade.version,
    actorId,
    action: 'broadcast',
    detail: txid,
    now,
    followUps: (g, gp) => [
      ctx.db
        .prepare(`UPDATE psbt_sessions SET status = 'broadcast', broadcast_at = ?, updated_at = ? WHERE id = ? AND ${g}`)
        .bind(now, now, session.id, ...gp),
      ctx.db
        .prepare(`INSERT OR REPLACE INTO scheduled_jobs (trade_id, next_poll_at, failures) SELECT ?, ?, 0 WHERE ${g}`)
        .bind(trade.id, now + 60, ...gp),
    ],
  });
  const parts = await listParticipants(ctx.db, trade.id);
  return [
    ...parts
      .filter((p) => isSigningRole(p.role) && !isOperator(ctx, p.telegram_user_id))
      .map((p) => ({
        chatId: p.telegram_user_id,
        ...sentMessage(trade.id, txid, ctx.net.name),
      })),
    ...groupNotice(trade, 'GESENDET'),
  ];
}

export function decodeUploadedPsbt(text: string): Uint8Array {
  const t = text.trim().replace(/\s+/g, '');
  if (t.startsWith('cHNidP8')) return base64.decode(t);
  if (/^70736274ff[0-9a-f]+$/i.test(t)) return hex.decode(t.toLowerCase());
  throw new UserError('Keine PSBT erkannt. Bitte Base64-Text oder .psbt-Datei senden.');
}

export { formatBps };

export function sentMessage(tradeId: string, txid: string, netName: 'signet' | 'mainnet'): MessageContent {
  const markup = `${b(`🚀 Handel #${esc(tradeId)}: Transaktion gesendet`)}\ntxid: ${code(txid)}\nWarte auf Bestätigungen.`;
  return {
    text: toPlain(markup),
    html: markup,
    buttons: [
      [
        { text: '🔎 Im Explorer ansehen', url: explorerTxUrl(netName, txid) },
        { text: '📋 txid kopieren', copy: txid },
      ],
    ],
  };
}

/** How to sign the payout in a wallet, in plain language (Sparrow). */
function signGuide(): MessageContent {
  const markup =
    `${b('✍️ So unterschreibst du die Auszahlung (Sparrow)')}\n` +
    '1. Die Datei unten speichern (oder den Text antippen, wird kopiert).\n' +
    `2. In Sparrow die Wallet dieses Handels öffnen → ${i('File → Open Transaction')} → Datei wählen (oder ${i('From Clipboard')}).\n` +
    '3. Prüfen: Empfänger und Beträge müssen genau wie in der Übersicht oben sein.\n' +
    `4. ${i('Finalize Transaction for Signing')} → ${i('Sign')}.\n` +
    `5. ${i('Save Transaction')} und die Datei hier zurückschicken (Button „Signierte PSBT hochladen“).\n\n` +
    i('Nicht in Sparrow senden („Broadcast“) – das macht der Bot, sobald 2 Unterschriften da sind.');
  return { text: toPlain(markup), html: markup };
}
