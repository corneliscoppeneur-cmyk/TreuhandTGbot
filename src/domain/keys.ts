import { hex } from '@scure/base';
import { deriveChildPubkey, formatPath, KeyError, parseSignerKey } from '../bitcoin/descriptor.ts';
import { ESCROW_INDEX } from '../config/constants.ts';
import { buildMultisig, type DerivedSigner, type RoleKey } from '../bitcoin/multisig.ts';
import type { EscrowScript } from '../bitcoin/psbt.ts';
import { auditStmt, getMultisig, getTrade, listParticipants, transition, type MultisigRow } from '../database/repo.ts';
import { looksLikeMnemonic, looksLikePrivateKey } from '../security/redaction.ts';
import type { MessageContent, Notice, ServiceCtx } from './context.ts';
import { b, btcForWallet, code, esc, explorerAddressUrl, i, pre, quote, toPlain } from '../telegram/format.ts';
import { UserError } from './context.ts';
import { formatBtc } from './amount.ts';
import { authorize, isSigningRole, signerIds } from './trade.ts';
import { adminNotices, isOperator } from './operator.ts';

interface SignerRow {
  role: 'buyer' | 'seller' | 'arbiter';
  fingerprint: string;
  derivation_path: string;
  xpub: string;
  escrow_pubkey_hex: string;
}

function rowToKey(r: SignerRow): RoleKey {
  const path = r.derivation_path.split('/').map((p) => (p.endsWith('h') ? Number(p.slice(0, -1)) + 0x80000000 : Number(p)));
  return { role: r.role, fingerprint: r.fingerprint, path, xpub: r.xpub, escrowPubkey: hex.decode(r.escrow_pubkey_hex) };
}

export function escrowFromRow(m: MultisigRow): EscrowScript {
  const signers = (
    JSON.parse(m.signers_json) as { role: DerivedSigner['role']; fingerprint: string; fullPath: number[]; pubkey: string }[]
  ).map((s) => ({ role: s.role, fingerprint: s.fingerprint, fullPath: s.fullPath, pubkey: hex.decode(s.pubkey) }));
  return { scriptPubKey: hex.decode(m.script_pubkey_hex), witnessScript: hex.decode(m.witness_script_hex), signers };
}

/** Multisig configuration for independent verification, with copy button and confirm/deny buttons. */
export function verificationMessage(m: MultisigRow, tradeId: string): MessageContent {
  const markup =
    `${b(`🔐 Handel #${esc(tradeId)}: Das Treuhand-Konto ist fertig`)}\n\n` +
    'Bevor jemand Geld einzahlt, prüft jeder selbst, dass das Konto echt ist und sein eigener Schlüssel drinsteckt. ' +
    'So kann niemand – auch nicht der Bot – eine falsche Adresse unterschieben.\n\n' +
    `${b('Adresse des Treuhand-Kontos:')}\n${code(m.address)}\n\n` +
    `${b('So prüfst du (Sparrow):')}\n` +
    '1. Den Code unten antippen (wird kopiert).\n' +
    `2. In Sparrow: ${i('File → New Wallet')} → Name „Handel ${esc(tradeId)}“ → ${i('Edit → Paste from clipboard')} bzw. Descriptor einfügen.\n` +
    `3. Im Reiter ${i('Receive')} muss genau diese Adresse als erste stehen.\n\n` +
    `${b('Kontodaten (Descriptor)')} – antippen zum Kopieren:\n${pre(m.descriptor)}\n` +
    quote('Stimmt die Adresse? Dann „Adresse stimmt überein“. Weicht sie ab: „Stimmt NICHT“ – und auf keinen Fall einzahlen.');
  return {
    text: toPlain(markup),
    html: markup,
    buttons: [
      [{ text: '📋 Adresse kopieren', copy: m.address }],
      [{ text: '✅ Adresse stimmt überein', data: `t:${tradeId}:verify:${m.address.slice(-8)}`, style: 'success' }],
      [{ text: '❌ Stimmt NICHT', data: `t:${tradeId}:verifyfail`, style: 'danger' }],
      [{ text: '📸 Bilder-Anleitung: Konto prüfen', data: 'g:trade-wallet' }],
    ],
  };
}

/** Private deposit instructions for the buyer: ONE address, ONE sum (trade amount + service fee). */
export function depositMessage(
  tradeId: string,
  amountSats: bigint,
  feeSats: bigint,
  address: string,
  netName: 'signet' | 'mainnet',
): MessageContent {
  const total = amountSats + feeSats;
  const test = netName === 'signet' ? ' (Test-Bitcoin)' : '';
  const markup =
    `${b(`💰 Handel #${esc(tradeId)}: Bereit zur Einzahlung`)}\n\n` +
    'Alle haben das Treuhand-Konto geprüft. Du kannst jetzt sicher einzahlen.\n\n' +
    `Bitte sende ${b(`genau ${esc(formatBtc(total))} BTC`)}${test} an:\n${code(address)}\n\n` +
    (feeSats > 0n
      ? `${i(`Darin enthalten: Handelsbetrag ${esc(formatBtc(amountSats))} BTC + Servicegebühr ${esc(formatBtc(feeSats))} BTC.`)}\n\n`
      : '') +
    `${b('Wichtig:')}\n` +
    '• Genau diese Summe senden – die Netzwerkgebühr deiner Wallet kommt obendrauf.\n' +
    '• Zu wenig gesendet? Dann wartet der Handel, bis der Rest da ist.\n' +
    '• Zu viel gesendet? Das wird akzeptiert, aber nicht erstattet – der Überschuss geht mit der Auszahlung an den Empfänger.\n' +
    '• Der Bot meldet sich, sobald das Geld angekommen und bestätigt ist (meist 10–30 Minuten).\n\n' +
    i('Datenschutz: Bitcoin-Adressen sind öffentlich einsehbar und nicht anonym.');
  return {
    text: toPlain(markup),
    html: markup,
    buttons: [
      [
        { text: '📋 Adresse kopieren', copy: address, style: 'primary' },
        { text: '📋 Summe kopieren', copy: btcForWallet(total) },
      ],
      [{ text: '🔎 Im Explorer ansehen', url: explorerAddressUrl(netName, address) }],
      [{ text: '📸 Bilder-Anleitung: Einzahlen', data: 'g:deposit' }],
    ],
  };
}

export async function registerKey(ctx: ServiceCtx, userId: number, tradeId: string, input: string): Promise<Notice[]> {
  if (looksLikeMnemonic(input) || looksLikePrivateKey(input)) {
    throw new UserError(
      `⚠️ Das ist ein PRIVATER Schlüssel oder eine Seed-Phrase. Lösche die Nachricht sofort und betrachte die Wallet als kompromittiert. Sende nur den öffentlichen Schlüssel (${ctx.net.name === 'signet' ? 'tpub' : 'xpub'}).`,
    );
  }
  const a = await authorize(ctx, userId, tradeId, 'register_key');
  if (a.trade.status !== 'KEY_SETUP') throw new UserError('Schlüssel können jetzt nicht registriert werden.');
  if (!isSigningRole(a.role)) throw new UserError('Nur Käufer, Verkäufer und Schlichter registrieren Schlüssel.');

  let key;
  try {
    key = parseSignerKey(input, ctx.net);
  } catch (e) {
    throw new UserError(e instanceof KeyError ? e.message : 'Schlüssel ungültig');
  }

  const existing = (
    await ctx.db
      .prepare('SELECT role, fingerprint, derivation_path, xpub, escrow_pubkey_hex FROM signers_public WHERE trade_id = ?')
      .bind(tradeId)
      .all<SignerRow>()
  ).results;
  if (existing.some((r) => r.role === a.role)) throw new UserError('Für deine Rolle ist bereits ein Schlüssel registriert.');
  if (existing.some((r) => r.fingerprint === key.fingerprint)) {
    throw new UserError('Dieser Master-Fingerprint wird bereits von einer anderen Partei genutzt. Jede Partei braucht eine eigene Wallet.');
  }
  const reused = await ctx.db.prepare('SELECT 1 AS x FROM signers_public WHERE xpub = ?').bind(key.xpub).first();
  if (reused)
    throw new UserError('Dieser Schlüssel wurde bereits in einem anderen Handel verwendet. Bitte ein neues Konto (account index) nutzen.');

  const now = ctx.now();
  await ctx.db.batch([
    ctx.db
      .prepare(
        'INSERT INTO signers_public (trade_id, role, telegram_user_id, fingerprint, derivation_path, xpub, escrow_pubkey_hex, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        tradeId,
        a.role,
        userId,
        key.fingerprint,
        formatPath(key.path),
        key.xpub,
        hex.encode(deriveChildPubkey(key, ctx.net, ESCROW_INDEX)),
        now,
      ),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'key_registered', detail: `${a.role}:${key.fingerprint}`, now }),
  ]);

  // re-read: concurrent registrations must still lead to exactly one config
  const all = (
    await ctx.db
      .prepare('SELECT role, fingerprint, derivation_path, xpub, escrow_pubkey_hex FROM signers_public WHERE trade_id = ?')
      .bind(tradeId)
      .all<SignerRow>()
  ).results;
  if (all.length < 3)
    return [
      {
        chatId: userId,
        text: `✅ Dein Schlüssel ist gespeichert (Wallet-Kennung ${key.fingerprint}). Sobald alle drei ihren Schlüssel gesendet haben, bekommst du die Adresse des Treuhand-Kontos zum Prüfen.`,
      },
    ];

  const cfg = buildMultisig(all.map(rowToKey), ctx.net);
  const created = await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO multisig_configs (trade_id, address, script_pubkey_hex, witness_script_hex, descriptor, signers_json, network, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tradeId,
        cfg.address,
        hex.encode(cfg.scriptPubKey),
        hex.encode(cfg.witnessScript),
        cfg.descriptor,
        JSON.stringify(
          cfg.signers.map((s) => ({ role: s.role, fingerprint: s.fingerprint, fullPath: s.fullPath, pubkey: hex.encode(s.pubkey) })),
        ),
        ctx.net.name,
        now,
      ),
    auditStmt(ctx.db, { tradeId, actorId: 0, action: 'multisig_created', now }),
  ]);
  if (created[0]?.meta.changes !== 1) return [];
  const m = (await getMultisig(ctx.db, tradeId))!;
  const s = signerIds(await listParticipants(ctx.db, tradeId));
  return [s.buyer, s.seller, s.arbiter]
    .filter((x): x is number => x !== undefined && !isOperator(ctx, x))
    .map((chatId) => ({
      chatId,
      ...verificationMessage(m, tradeId),
    }));
}

export async function confirmAddress(ctx: ServiceCtx, userId: number, tradeId: string, addressSuffix: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'verify_address');
  if (a.trade.status !== 'KEY_SETUP') throw new UserError('Jetzt nicht möglich.');
  const m = await getMultisig(ctx.db, tradeId);
  if (!m || m.address.slice(-8) !== addressSuffix) throw new UserError('Konfiguration hat sich geändert. Bitte neu prüfen.');
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db
      .prepare('UPDATE participants SET address_verified_at = ? WHERE id = ? AND address_verified_at IS NULL')
      .bind(now, a.participant!.id),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'address_verified', now }),
  ]);
  const parts = await listParticipants(ctx.db, tradeId);
  const signers = parts.filter((p) => isSigningRole(p.role));
  if (signers.length !== 3 || !signers.every((p) => p.address_verified_at !== null)) {
    return [{ chatId: userId, text: '✅ Danke, deine Prüfung ist gespeichert. Sobald alle bestätigt haben, kann der Käufer einzahlen.' }];
  }
  const trade = (await getTrade(ctx.db, tradeId))!;
  await transition(ctx.db, {
    tradeId,
    from: 'KEY_SETUP',
    to: 'READY_TO_FUND',
    expectedVersion: trade.version,
    actorId: 0,
    action: 'params_locked',
    now,
    set: { sql: 'params_locked_at = ?', params: [now] },
    followUps: (g, gp) => [
      ctx.db
        .prepare(`INSERT OR REPLACE INTO scheduled_jobs (trade_id, next_poll_at, failures) SELECT ?, ?, 0 WHERE ${g}`)
        .bind(tradeId, now, ...gp),
    ],
  });
  const s = signerIds(parts);
  const out: Notice[] = signers
    .filter((p) => p.role !== 'buyer' && !isOperator(ctx, p.telegram_user_id))
    .map((p) => ({
      chatId: p.telegram_user_id,
      text: `🔐 Handel #${tradeId}: Alle haben das Treuhand-Konto bestätigt. Jetzt ist der Käufer mit der Einzahlung dran – du wirst benachrichtigt, sobald das Geld angekommen ist.`,
    }));
  out.push({ chatId: s.buyer!, ...depositMessage(tradeId, BigInt(trade.amount_sats), BigInt(trade.fee_sats), m.address, ctx.net.name) });
  out.push(
    ...adminNotices(
      ctx,
      `Handel #${tradeId} wartet auf Einzahlung: ${formatBtc(BigInt(trade.amount_sats) + BigInt(trade.fee_sats))} BTC (davon Gebühr ${formatBtc(BigInt(trade.fee_sats))} BTC).`,
    ),
  );
  return out;
}

export async function reportAddressMismatch(ctx: ServiceCtx, userId: number, tradeId: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'verify_address');
  const now = ctx.now();
  await auditStmt(ctx.db, { tradeId, actorId: userId, action: 'address_mismatch_reported', now }).run();
  const parts = await listParticipants(ctx.db, tradeId);
  return parts
    .filter((p) => isSigningRole(p.role))
    .map((p) => ({
      chatId: p.telegram_user_id,
      text: `⚠️ Handel #${a.trade.id}: Eine Partei meldet, dass die Multisig-Adresse NICHT übereinstimmt. Nicht einzahlen! Bitte Handel abbrechen und neu aufsetzen.`,
      buttons: [[{ text: 'Handel abbrechen', data: `t:${a.trade.id}:cancel`, style: 'danger' as const }]],
    }));
}
