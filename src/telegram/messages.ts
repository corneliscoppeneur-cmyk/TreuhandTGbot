import type { AppConfig } from '../config/env.ts';
import { formatBtc } from '../domain/amount.ts';
import type { MessageContent } from '../domain/context.ts';
import { formatBps } from '../domain/fees.ts';
import { ROLE_LABEL_DE, type Role } from '../domain/permissions.ts';
import { STATE_LABEL_DE } from '../domain/state-machine.ts';
import type { ParticipantRow, TradeRow } from '../database/repo.ts';
import { b, code, esc, i, link, quote, table, time, toPlain } from './format.ts';

export function html(markup: string): MessageContent {
  return { text: toPlain(markup), html: markup };
}

export function rich(markup: string): MessageContent {
  return { text: toPlain(markup), rich: markup };
}

export const MAIN_MENU = html(
  `${b('₿ BTC TREUHAND')}\n\nSichere Bitcoin-Handelskoordination über ${b('2-von-3-Multisig')}.\n` +
    `${i('Der Bot verwahrt keine Coins und keine Schlüssel. Testnetz: Signet.')}`,
);

export function privacyText(cfg: AppConfig): MessageContent {
  return html(
    `${b('🔒 Vertrauliche Informationen')}\n\n` +
      'Bitte keine persönlichen Anschriften, Wallet-Adressen, Zugangsdaten oder vertraulichen Dokumente in gemeinsamen Handelschats veröffentlichen.\n\n' +
      `Für sensible Informationen kann ein verschlüsselter Einmal-Link über ${link(cfg.cryptgeonUrl, 'cryptgeon.org')} verwendet werden. ` +
      'Prüfe, dass der Link wirklich auf diese Domain zeigt (Vorsicht vor gefälschten Links).\n\n' +
      `${b('Niemals übermitteln:')}\n• Seed-Phrasen\n• private Bitcoin-Schlüssel\n• Wallet-Passwörter\n• Wiederherstellungswörter\n• Zugangsdaten anderer Dienste\n\n` +
      `${i('Cryptgeon ist keine sichere Aufbewahrungsmöglichkeit für Bitcoin-Private-Keys.')}\n\n` +
      quote(
        'Datenschutz: Gespeichert werden Telegram-ID, Handelsdaten, öffentliche Schlüssel und ein minimales Audit-Log. ' +
          'Freitexte abgeschlossener Handel werden nach Ablauf der Aufbewahrungsfrist gelöscht. ' +
          'Bitcoin-Adressen sind nicht anonym; externe Blockchain-APIs können abgefragte Adressen beobachten.',
        true,
      ),
  );
}

export function feesHtml(cfg: AppConfig): string {
  return (
    `${b('💸 Gebühren (Version 1)')}\n\n` +
    `• Servicegebühr bei Auszahlung an den Verkäufer: ${b(formatBps(cfg.commissionBps))} des Handelsbetrags, als eigener, sichtbarer Output der Transaktion.\n` +
    `• Servicegebühr bei Rückerstattung: ${b(formatBps(cfg.refundCommissionBps))}.\n` +
    '• Streitfall: es gilt die Regel des Ergebnisses (Auszahlung oder Rückerstattung).\n' +
    '• Netzwerkgebühr (Miner): trägt der Empfänger der Auszahlung; wird aus der aktuellen Gebührenschätzung berechnet.\n' +
    `• Maximal ${esc(cfg.maxFeeRateSatVb)} sat/vB und höchstens ${esc(cfg.maxFeePercent)} % des Betrags; sonst wird keine Transaktion erstellt.\n` +
    '• Gebühren unter der Dust-Grenze entfallen.\n' +
    '• Jede Änderung von Beträgen oder Gebühren erfordert neue Signaturen.\n\n' +
    quote(
      'Transparenz: Die Provision ist technisch NICHT garantiert. Käufer und Verkäufer können gemeinsam ohne den Bot signieren. ' +
        'Das ist eine bewusste Folge des nichtverwahrenden Modells. Netzwerkgebühren auf Mainnet sind nie kostenlos.',
    )
  );
}

export function feesText(cfg: AppConfig): MessageContent {
  return html(feesHtml(cfg));
}

export const HELP = html(
  `${b('❓ Hilfe und Sicherheit')}\n\n` +
    'Ablauf: Handel anlegen → Käufer, Verkäufer und Schlichter einladen → Bedingungen bestätigen → ' +
    'jede Partei registriert einen öffentlichen Multisig-Schlüssel (tpub) → alle prüfen die Adresse in der eigenen Wallet → ' +
    'Käufer zahlt ein → Lieferung → Auszahlung per PSBT mit 2 von 3 Signaturen.\n\n' +
    `${b('Der Bot:')}\n• verwahrt keine BTC und keine privaten Schlüssel\n• fragt niemals nach Seed oder privatem Schlüssel\n` +
    '• kann BTC on-chain nicht einfrieren oder zurückholen\n• kann Multisig nur mit kompatibler Wallet nutzen (siehe Doku)\n\n' +
    `Befehle: /newtrade /mytrades ${esc('/trade <ID>')} ${esc('/invites <ID>')} /disputes /fees /privacy /support /status /cancel`,
);

export const SECURITY = html(
  `${b('🛡 Sicherheitsinformationen')}\n\n` +
    '• Ein kompromittiertes Telegram-Konto allein kann keine BTC auszahlen – dafür sind 2 Wallet-Signaturen nötig.\n' +
    '• Nutze für jeden Handel ein neues Wallet-Konto (Account-Index).\n' +
    '• Prüfe Adresse und PSBT immer in deiner eigenen Wallet.\n' +
    '• Der Schlichter muss eine wirklich unabhängige Person mit eigener Wallet sein.\n' +
    '• Admins und Support fragen niemals nach Seeds, Schlüsseln oder Zahlungen.',
);

function roleStatus(t: TradeRow, parts: ParticipantRow[], r: Role): string {
  const p = parts.find((x) => x.role === r);
  if (!p) return '⏳ offen';
  if (t.status === 'AGREEMENT') return p.agreed_hash === t.agreement_hash ? '✅ zugestimmt' : '👋 beigetreten';
  if (t.status === 'KEY_SETUP') return p.address_verified_at ? '✅ Adresse bestätigt' : '🔑 Schlüssel/Prüfung';
  return '✅ bestätigt';
}

/** Trade overview as rich message (table); falls back to HTML automatically. */
export function tradeView(t: TradeRow, parts: ParticipantRow[], myRole: Role | null): MessageContent {
  const others = parts.filter((p) => p.role === 'mediator' || p.role === 'observer').length;
  const markup =
    `<h3>₿ BTC-TREUHAND · #${esc(t.id)}</h3>` +
    `<p>${b(esc(t.title))}</p>` +
    table(
      [
        ['Betrag', `${b(esc(formatBtc(BigInt(t.amount_sats))))} BTC`],
        ['Provision', esc(formatBps(t.commission_bps))],
        ['Netzwerkgebühr', 'separat'],
        ['Sicherheit', '2-von-3-Multisig'],
        ['Netzwerk', esc(t.network)],
        ['Erstellt', time(t.created_at, 'dt')],
      ],
      false,
    ) +
    table([
      ['Rolle', 'Status'],
      ['Käufer', roleStatus(t, parts, 'buyer')],
      ['Verkäufer', roleStatus(t, parts, 'seller')],
      ['Schlichter', roleStatus(t, parts, 'arbiter')],
    ]) +
    `<p>Weitere Teilnehmer: ${others}${myRole ? ` · Deine Rolle: ${b(ROLE_LABEL_DE[myRole])}` : ''}</p>` +
    `<p>Status: ${b(esc(STATE_LABEL_DE[t.status]))}${t.status === 'NEEDS_REVIEW' && t.review_reason ? `<br>Grund: ${esc(t.review_reason)}` : ''}</p>`;
  return rich(markup);
}

/** Terms as rich message with expandable sections. */
export function termsView(t: TradeRow): MessageContent {
  const markup =
    `<h3>📜 Bedingungen · Handel #${esc(t.id)}</h3>` +
    `<p>Vertragsversion ${esc(t.contract_version)} · ${b(esc(t.title))}</p>` +
    `<details open><summary>Beschreibung</summary><p>${esc(t.description)}</p></details>` +
    `<details open><summary>Handelsbedingungen</summary><p>${esc(t.terms)}</p></details>` +
    table(
      [
        ['Betrag', `${esc(formatBtc(BigInt(t.amount_sats)))} BTC`],
        ['Provision Auszahlung', esc(formatBps(t.commission_bps))],
        ['Provision Rückerstattung', esc(formatBps(t.refund_commission_bps))],
        ['Netzwerkgebühr', 'trägt der Empfänger'],
      ],
      false,
    ) +
    (t.agreement_hash ? `<p>Prüfsumme: ${code(t.agreement_hash.slice(0, 16))}</p>` : '');
  return rich(markup);
}
