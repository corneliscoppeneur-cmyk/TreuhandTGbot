import { hex } from '@scure/base';
import { formatPath, KeyError, parseSignerKey } from '../bitcoin/descriptor.ts';
import { buildMultisig, type DerivedSigner, type RoleKey } from '../bitcoin/multisig.ts';
import type { EscrowScript } from '../bitcoin/psbt.ts';
import { auditStmt, getMultisig, getTrade, listParticipants, transition, type MultisigRow } from '../database/repo.ts';
import { looksLikeMnemonic, looksLikePrivateKey } from '../security/redaction.ts';
import type { Notice, ServiceCtx } from './context.ts';
import { UserError } from './context.ts';
import { formatBtc } from './amount.ts';
import { authorize, isSigningRole, signerIds } from './trade.ts';

interface SignerRow {
  role: 'buyer' | 'seller' | 'arbiter';
  fingerprint: string;
  derivation_path: string;
  xpub: string;
}

function rowToKey(r: SignerRow): RoleKey {
  const path = r.derivation_path.split('/').map((p) => (p.endsWith('h') ? Number(p.slice(0, -1)) + 0x80000000 : Number(p)));
  return { role: r.role, fingerprint: r.fingerprint, path, xpub: r.xpub };
}

export function escrowFromRow(m: MultisigRow): EscrowScript {
  const signers = (JSON.parse(m.signers_json) as { role: DerivedSigner['role']; fingerprint: string; fullPath: number[]; pubkey: string }[]).map(
    (s) => ({ role: s.role, fingerprint: s.fingerprint, fullPath: s.fullPath, pubkey: hex.decode(s.pubkey) }),
  );
  return { scriptPubKey: hex.decode(m.script_pubkey_hex), witnessScript: hex.decode(m.witness_script_hex), signers };
}

export function verificationText(m: MultisigRow, tradeId: string): string {
  return (
    `Handel #${tradeId} – Multisig-Konfiguration (2-von-3, P2WSH)\n\n` +
    `Descriptor:\n${m.descriptor}\n\n` +
    `Erwartete Einzahlungsadresse (Index 0):\n${m.address}\n\n` +
    'So prüfst du unabhängig: In Sparrow „Datei → Neue Wallet → Descriptor einfügen“ (oder Bitcoin Core: ' +
    '`deriveaddresses "<descriptor>" "[0,0]"`). Die erste Empfangsadresse muss exakt übereinstimmen und ' +
    'dein eigener Schlüssel muss enthalten sein. Erst dann bestätigen.'
  );
}

export async function registerKey(ctx: ServiceCtx, userId: number, tradeId: string, input: string): Promise<Notice[]> {
  if (looksLikeMnemonic(input) || looksLikePrivateKey(input)) {
    throw new UserError(
      '⚠️ Das ist ein PRIVATER Schlüssel oder eine Seed-Phrase. Lösche die Nachricht sofort und betrachte die Wallet als kompromittiert. Sende nur den öffentlichen Schlüssel (tpub).',
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
    await ctx.db.prepare('SELECT role, fingerprint, derivation_path, xpub FROM signers_public WHERE trade_id = ?').bind(tradeId).all<SignerRow>()
  ).results;
  if (existing.some((r) => r.role === a.role)) throw new UserError('Für deine Rolle ist bereits ein Schlüssel registriert.');
  if (existing.some((r) => r.fingerprint === key.fingerprint)) {
    throw new UserError('Dieser Master-Fingerprint wird bereits von einer anderen Partei genutzt. Jede Partei braucht eine eigene Wallet.');
  }
  const reused = await ctx.db.prepare('SELECT 1 AS x FROM signers_public WHERE xpub = ?').bind(key.xpub).first();
  if (reused) throw new UserError('Dieser Schlüssel wurde bereits in einem anderen Handel verwendet. Bitte ein neues Konto (account index) nutzen.');

  const now = ctx.now();
  await ctx.db.batch([
    ctx.db
      .prepare('INSERT INTO signers_public (trade_id, role, telegram_user_id, fingerprint, derivation_path, xpub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(tradeId, a.role, userId, key.fingerprint, formatPath(key.path), key.xpub, now),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'key_registered', detail: `${a.role}:${key.fingerprint}`, now }),
  ]);

  // re-read: concurrent registrations must still lead to exactly one config
  const all = (
    await ctx.db.prepare('SELECT role, fingerprint, derivation_path, xpub FROM signers_public WHERE trade_id = ?').bind(tradeId).all<SignerRow>()
  ).results;
  if (all.length < 3) return [{ chatId: userId, text: `Schlüssel gespeichert (Fingerprint ${key.fingerprint}). Warte auf die anderen Parteien.` }];

  const cfg = buildMultisig(all.map(rowToKey), ctx.net);
  const created = await ctx.db.batch([
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO multisig_configs (trade_id, address, script_pubkey_hex, witness_script_hex, descriptor, signers_json, network, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(tradeId, cfg.address, hex.encode(cfg.scriptPubKey), hex.encode(cfg.witnessScript), cfg.descriptor,
        JSON.stringify(cfg.signers.map((s) => ({ role: s.role, fingerprint: s.fingerprint, fullPath: s.fullPath, pubkey: hex.encode(s.pubkey) }))),
        ctx.net.name, now),
    auditStmt(ctx.db, { tradeId, actorId: 0, action: 'multisig_created', now }),
  ]);
  if (created[0]?.meta.changes !== 1) return [];
  const m = (await getMultisig(ctx.db, tradeId))!;
  const s = signerIds(await listParticipants(ctx.db, tradeId));
  return [s.buyer, s.seller, s.arbiter].filter((x): x is number => x !== undefined).map((chatId) => ({
    chatId,
    text: verificationText(m, tradeId),
    buttons: [[{ text: 'Adresse stimmt überein', data: `t:${tradeId}:verify:${m.address.slice(-8)}` }], [{ text: 'Stimmt NICHT', data: `t:${tradeId}:verifyfail` }]],
  }));
}

export async function confirmAddress(ctx: ServiceCtx, userId: number, tradeId: string, addressSuffix: string): Promise<Notice[]> {
  const a = await authorize(ctx, userId, tradeId, 'verify_address');
  if (a.trade.status !== 'KEY_SETUP') throw new UserError('Jetzt nicht möglich.');
  const m = await getMultisig(ctx.db, tradeId);
  if (!m || m.address.slice(-8) !== addressSuffix) throw new UserError('Konfiguration hat sich geändert. Bitte neu prüfen.');
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db.prepare('UPDATE participants SET address_verified_at = ? WHERE id = ? AND address_verified_at IS NULL').bind(now, a.participant!.id),
    auditStmt(ctx.db, { tradeId, actorId: userId, action: 'address_verified', now }),
  ]);
  const parts = await listParticipants(ctx.db, tradeId);
  const signers = parts.filter((p) => isSigningRole(p.role));
  if (signers.length !== 3 || !signers.every((p) => p.address_verified_at !== null)) {
    return [{ chatId: userId, text: 'Bestätigt. Warte auf die anderen Parteien.' }];
  }
  const trade = (await getTrade(ctx.db, tradeId))!;
  await transition(ctx.db, {
    tradeId, from: 'KEY_SETUP', to: 'READY_TO_FUND', expectedVersion: trade.version, actorId: 0, action: 'params_locked', now,
    set: { sql: 'params_locked_at = ?', params: [now] },
    followUps: (g, gp) => [
      ctx.db
        .prepare(`INSERT OR REPLACE INTO scheduled_jobs (trade_id, next_poll_at, failures) SELECT ?, ?, 0 WHERE ${g}`)
        .bind(tradeId, now, ...gp),
    ],
  });
  const s = signerIds(parts);
  const out: Notice[] = signers
    .filter((p) => p.role !== 'buyer')
    .map((p) => ({ chatId: p.telegram_user_id, text: `Handel #${tradeId}: Konfiguration bestätigt. Warte auf Einzahlung des Käufers.` }));
  out.push({
    chatId: s.buyer!,
    text:
      `Handel #${tradeId}: Bereit zur Einzahlung.\n\n` +
      `Betrag: exakt ${formatBtc(BigInt(trade.amount_sats))} BTC (${ctx.net.name})\n` +
      `Adresse (2-von-3-Multisig):\n${m.address}\n\n` +
      'Bitte genau diesen Betrag in EINER oder mehreren Zahlungen senden. Die Summe muss exakt stimmen; ' +
      'Überzahlungen führen zu manueller Prüfung. Netzwerkgebühren der Einzahlung trägst du.\n' +
      'Hinweis: Blockchain-APIs können abgefragte Adressen beobachten. Bitcoin-Adressen sind nicht anonym.',
  });
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
    }));
}
