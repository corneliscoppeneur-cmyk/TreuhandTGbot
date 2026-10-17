import type { AppConfig } from '../config/env.ts';
import { formatBtc } from '../domain/amount.ts';
import { formatBps } from '../domain/fees.ts';
import { ROLE_LABEL_DE, type Role } from '../domain/permissions.ts';
import { STATE_LABEL_DE } from '../domain/state-machine.ts';
import type { ParticipantRow, TradeRow } from '../database/repo.ts';

export const MAIN_MENU_TEXT =
  'BTC TREUHAND\n\nSichere Bitcoin-Handelskoordination über 2-von-3-Multisig.\n' +
  'Der Bot verwahrt keine Coins und keine Schlüssel. Testnetz: Signet.';

export function privacyText(cfg: AppConfig): string {
  return (
    'Vertrauliche Informationen\n\n' +
    'Bitte keine persönlichen Anschriften, Wallet-Adressen, Zugangsdaten oder vertraulichen Dokumente in gemeinsamen Handelschats veröffentlichen.\n\n' +
    `Für sensible Informationen kann ein verschlüsselter Einmal-Link über ${cfg.cryptgeonUrl} verwendet werden. ` +
    'Prüfe, dass der Link wirklich auf diese Domain zeigt (Vorsicht vor gefälschten Links).\n\n' +
    'Niemals übermitteln:\n• Seed-Phrasen\n• private Bitcoin-Schlüssel\n• Wallet-Passwörter\n• Wiederherstellungswörter\n• Zugangsdaten anderer Dienste\n\n' +
    'Cryptgeon ist keine sichere Aufbewahrungsmöglichkeit für Bitcoin-Private-Keys.\n\n' +
    'Datenschutz: Gespeichert werden Telegram-ID, Handelsdaten, öffentliche Schlüssel und ein minimales Audit-Log. ' +
    'Freitexte abgeschlossener Handel werden nach Ablauf der Aufbewahrungsfrist gelöscht. ' +
    'Bitcoin-Adressen sind nicht anonym; externe Blockchain-APIs können abgefragte Adressen beobachten.'
  );
}

export function feesText(cfg: AppConfig): string {
  return (
    'Gebühren (Version 1)\n\n' +
    `• Servicegebühr bei Auszahlung an den Verkäufer: ${formatBps(cfg.commissionBps)} des Handelsbetrags, als eigener, sichtbarer Output der Transaktion.\n` +
    `• Servicegebühr bei Rückerstattung: ${formatBps(cfg.refundCommissionBps)}.\n` +
    '• Streitfall: es gilt die Regel des Ergebnisses (Auszahlung oder Rückerstattung).\n' +
    '• Netzwerkgebühr (Miner): trägt der Empfänger der Auszahlung; wird aus der aktuellen Gebührenschätzung berechnet.\n' +
    `• Maximal ${cfg.maxFeeRateSatVb} sat/vB und höchstens ${cfg.maxFeePercent} % des Betrags; sonst wird keine Transaktion erstellt.\n` +
    '• Gebühren unter der Dust-Grenze entfallen.\n' +
    '• Jede Änderung von Beträgen oder Gebühren erfordert neue Signaturen.\n\n' +
    'Transparenz: Die Provision ist technisch NICHT garantiert. Käufer und Verkäufer können gemeinsam ohne den Bot signieren. ' +
    'Das ist eine bewusste Folge des nichtverwahrenden Modells. Netzwerkgebühren auf Mainnet sind nie kostenlos.'
  );
}

export const HELP_TEXT =
  'Hilfe und Sicherheit\n\n' +
  'Ablauf: Handel anlegen → Käufer, Verkäufer und Schlichter einladen → Bedingungen bestätigen → ' +
  'jede Partei registriert einen öffentlichen Multisig-Schlüssel (tpub) → alle prüfen die Adresse in der eigenen Wallet → ' +
  'Käufer zahlt ein → Lieferung → Auszahlung per PSBT mit 2 von 3 Signaturen.\n\n' +
  'Der Bot:\n• verwahrt keine BTC und keine privaten Schlüssel\n• fragt niemals nach Seed oder privatem Schlüssel\n' +
  '• kann BTC on-chain nicht einfrieren oder zurückholen\n• kann Multisig nur mit kompatibler Wallet nutzen (getestet: siehe Doku)\n\n' +
  'Befehle: /newtrade /mytrades /trade <ID> /invites <ID> /disputes /fees /privacy /support /status /cancel';

export function securityText(): string {
  return (
    'Sicherheitsinformationen\n\n' +
    '• Ein kompromittiertes Telegram-Konto allein kann keine BTC auszahlen – dafür sind 2 Wallet-Signaturen nötig.\n' +
    '• Nutze für jeden Handel ein neues Wallet-Konto (Account-Index).\n' +
    '• Prüfe Adresse und PSBT immer in deiner eigenen Wallet.\n' +
    '• Der Schlichter muss eine wirklich unabhängige Person mit eigener Wallet sein.\n' +
    '• Admins und Support fragen niemals nach Seeds, Schlüsseln oder Zahlungen.'
  );
}

export function tradeView(t: TradeRow, parts: ParticipantRow[], myRole: Role | null): string {
  const role = (r: Role) => {
    const p = parts.find((x) => x.role === r);
    if (!p) return 'offen';
    if (t.status === 'AGREEMENT') return p.agreed_hash === t.agreement_hash ? 'zugestimmt' : 'beigetreten';
    return 'bestätigt';
  };
  const others = parts.filter((p) => p.role === 'mediator' || p.role === 'observer').length;
  return (
    'BTC-TREUHAND\n\n' +
    `Handel: #${t.id}\nTitel: ${t.title}\nBetrag: ${formatBtc(BigInt(t.amount_sats))} BTC\n` +
    `Provision: ${formatBps(t.commission_bps)}\nNetzwerkgebühr: separat\nSicherheit: 2-von-3-Multisig\nNetzwerk: ${t.network}\n\n` +
    `Käufer: ${role('buyer')}\nVerkäufer: ${role('seller')}\nSchlichter: ${role('arbiter')}\n\n` +
    `Weitere Teilnehmer: ${others}\n` +
    (myRole ? `Deine Rolle: ${ROLE_LABEL_DE[myRole]}\n` : '') +
    `\nStatus: ${STATE_LABEL_DE[t.status]}` +
    (t.status === 'NEEDS_REVIEW' && t.review_reason ? `\nGrund: ${t.review_reason}` : '')
  );
}

export function termsView(t: TradeRow): string {
  return (
    `Bedingungen Handel #${t.id} (Vertragsversion ${t.contract_version})\n\n` +
    `Titel: ${t.title}\n\nBeschreibung:\n${t.description}\n\nBedingungen:\n${t.terms}\n\n` +
    `Betrag: ${formatBtc(BigInt(t.amount_sats))} BTC\nProvision Auszahlung: ${formatBps(t.commission_bps)} · Rückerstattung: ${formatBps(t.refund_commission_bps)}\n` +
    'Netzwerkgebühr trägt der Empfänger. Gebührenregeln: /fees\n' +
    (t.agreement_hash ? `\nPrüfsumme: ${t.agreement_hash.slice(0, 16)}` : '')
  );
}
