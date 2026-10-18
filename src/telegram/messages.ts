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
  `${b('₿ BTC TREUHAND')}\n` +
    `${i('Sicher mit Bitcoin handeln – ohne dem Gegenüber blind vertrauen zu müssen.')}\n\n` +
    `${b('So funktioniert es:')}\n` +
    '1️⃣ Du legst einen Handel an und lädst Käufer bzw. Verkäufer und einen neutralen Schlichter ein.\n' +
    '2️⃣ Der Käufer zahlt auf ein gemeinsames Treuhand-Konto. Es öffnet sich nur, wenn 2 der 3 Beteiligten zustimmen.\n' +
    '3️⃣ Ist die Ware da, geben Käufer und Verkäufer das Geld gemeinsam frei. Bei Streit entscheidet der Schlichter.\n\n' +
    `🔒 ${b('Der Bot hat nie Zugriff auf dein Geld')} – er hält keine Coins und keine Schlüssel.\n` +
    `🧪 ${i('Testbetrieb: Es wird mit Test-Bitcoin (Signet) gehandelt, die keinen Wert haben.')}`,
);

/** Plain-language glossary, used in help and wherever a technical term first appears. */
export const GLOSSARY =
  `${b('Begriffe kurz erklärt')}\n` +
  `• ${b('Treuhand-Konto (Multisig)')}: ein gemeinsames Bitcoin-Schließfach mit 3 Schlüsseln. 2 davon sind zum Öffnen nötig.\n` +
  `• ${b('Öffentlicher Schlüssel (tpub)')}: wie eine Kontonummer – ungefährlich zu teilen. Damit wird das Schließfach gebaut.\n` +
  `• ${b('Seed / Wiederherstellungswörter')}: dein Generalschlüssel. ${b('Niemals teilen')}, auch nicht mit dem Bot oder Support.\n` +
  `• ${b('PSBT')}: ein Überweisungsentwurf. Deine Wallet zeigt ihn dir an, du prüfst ihn und unterschreibst.\n` +
  `• ${b('Schlichter')}: neutrale dritte Person. Entscheidet nur im Streitfall und kann allein nie auszahlen.\n` +
  `• ${b('Signet')}: Bitcoin-Testnetz. Coins haben keinen Wert – ideal zum Ausprobieren.`;

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
  const example = 1_000_000n; // 0,01 BTC
  const raw = (example * BigInt(cfg.commissionBps)) / 10_000n;
  const fee = cfg.commissionBps === 0 ? 0n : raw < 546n ? 546n : raw;
  return (
    `${b('💸 Was kostet das?')}\n\n` +
    `• ${b('Servicegebühr:')} ${b(formatBps(cfg.commissionBps))} vom Handelsbetrag (mindestens 546 sat). Sie ist in der Einzahlung enthalten – der Käufer zahlt ${b('eine Summe an eine Adresse')}.\n` +
    '• Die Servicegebühr geht bei jeder Auszahlung automatisch an den Betreiber – auch bei einer Rückzahlung an den Käufer. Sie wird nicht erstattet.\n' +
    `• ${b('Netzwerkgebühr:')} kleine Gebühr an das Bitcoin-Netzwerk. Bei der Einzahlung zahlt sie der Käufer, bei der Auszahlung der Empfänger.\n\n` +
    `${b('Beispiel')} bei einem Handel über ${esc(formatBtc(example))} BTC:\n` +
    `Der Käufer zahlt ${b(`${esc(formatBtc(example + fee))} BTC`)} ein (${esc(formatBtc(example))} Handel + ${esc(formatBtc(fee))} Gebühr). ` +
    `Der Verkäufer erhält ca. ${esc(formatBtc(example - 300n))} BTC (Handelsbetrag minus Netzwerkgebühr).\n\n` +
    `🛡 ${i(`Schutz vor Abzocke: Ist die Netzwerkgebühr gerade über ${cfg.maxFeeRateSatVb} sat/vB oder über ${cfg.maxFeePercent} % des Betrags, wird keine Auszahlung erstellt – einfach später erneut versuchen.`)}\n\n` +
    quote('Fair Play: Wer das Treuhand-Geld am Bot vorbei auszahlt, um die Gebühr zu umgehen, wird automatisch gesperrt.')
  );
}

export function feesText(cfg: AppConfig): MessageContent {
  return html(feesHtml(cfg));
}

export const HELP = html(
  `${b('❓ So läuft ein Handel ab')}\n\n` +
    `${b('1. Anlegen')} – Titel, Beschreibung, Betrag und Bedingungen eingeben, eigene Rolle wählen.\n` +
    `${b('2. Einladen')} – Link und Zugangscode an Käufer/Verkäufer und an einen neutralen Schlichter schicken (am besten getrennt).\n` +
    `${b('3. Zustimmen')} – alle drei lesen die Bedingungen und tippen auf „Akzeptieren“.\n` +
    `${b('4. Schlüssel')} – jeder sendet seinen öffentlichen Wallet-Schlüssel. Daraus entsteht das gemeinsame Treuhand-Konto.\n` +
    `${b('5. Prüfen')} – jeder vergleicht die Treuhand-Adresse in seiner eigenen Wallet und bestätigt.\n` +
    `${b('6. Einzahlen')} – der Käufer überweist den genauen Betrag. Der Bot meldet, sobald das Geld sicher angekommen ist.\n` +
    `${b('7. Liefern')} – der Verkäufer liefert und meldet es im Bot.\n` +
    `${b('8. Freigeben')} – der Käufer gibt frei, beide unterschreiben die Auszahlung in ihrer Wallet, der Bot sendet sie ab.\n\n` +
    `${b('Probleme?')} Tippe im Handel auf „Probleme mit Admin“. Dann stoppt der Bot alle Auszahlungen und der Schlichter entscheidet.\n\n` +
    `${GLOSSARY}\n\n` +
    `${b('Befehle')}: /newtrade neuer Handel · /mytrades meine Handel · /fees Gebühren · /privacy Datenschutz · /support Hilfe · /cancel Eingabe abbrechen`,
);

export const SECURITY = html(
  `${b('🛡 Deine Sicherheit')}\n\n` +
    `• ${b('Dein Geld liegt nie beim Bot.')} Es liegt im gemeinsamen Treuhand-Konto, das nur mit 2 von 3 Unterschriften aufgeht.\n` +
    '• Selbst wenn jemand dein Telegram-Konto übernimmt, kann er ohne deine Wallet kein Geld bewegen.\n' +
    `• ${b('Niemand fragt dich nach deinen Wiederherstellungswörtern')} – weder der Bot noch der Support noch ein Admin. Wer das tut, ist ein Betrüger.\n` +
    '• Prüfe vor jeder Unterschrift in deiner Wallet: Stimmen Empfänger und Betrag?\n' +
    '• Nutze für jeden Handel ein neues Wallet-Konto.\n' +
    '• Wähle als Schlichter eine Person, der beide Seiten vertrauen und die mit keiner Seite verbandelt ist.\n' +
    '• Sensible Infos (z. B. Lieferadresse) nie im Gruppenchat posten, sondern per verschlüsseltem Einmal-Link.',
);

/** One clear instruction: what this user should do now in this trade. */
export function nextStep(t: TradeRow, role: Role | null, me: ParticipantRow | null, sigCount: number): string {
  const signer = role === 'buyer' || role === 'seller' || role === 'arbiter';
  switch (t.status) {
    case 'INVITING':
      return role === 'buyer' || role === 'seller'
        ? 'Lade die fehlenden Beteiligten ein: Tippe auf „Einladungen“ und schicke Link und Code getrennt.'
        : 'Warte, bis alle Beteiligten beigetreten sind.';
    case 'AGREEMENT':
      return signer && me?.agreed_hash !== t.agreement_hash
        ? 'Lies die Bedingungen und tippe auf „Bedingungen prüfen & akzeptieren“.'
        : 'Warte, bis alle den Bedingungen zugestimmt haben.';
    case 'KEY_SETUP':
      return signer && !me?.address_verified_at
        ? 'Sende deinen öffentlichen Wallet-Schlüssel und prüfe danach die Treuhand-Adresse. Noch keine Wallet? Tippe auf „Wallet einrichten“.'
        : 'Warte, bis alle ihren Schlüssel gesendet und die Adresse bestätigt haben.';
    case 'READY_TO_FUND':
      return role === 'buyer'
        ? 'Überweise jetzt den genauen Betrag auf die Treuhand-Adresse (siehe „Zahlungsstatus“).'
        : 'Warte auf die Einzahlung des Käufers. Du wirst benachrichtigt.';
    case 'FUNDING_SEEN':
      return 'Die Zahlung ist unterwegs. Sobald das Netzwerk sie bestätigt, geht es weiter – meist innerhalb von 10–30 Minuten.';
    case 'FUNDED':
      return role === 'seller'
        ? 'Das Geld liegt sicher im Treuhand-Konto. Liefere jetzt und tippe dann auf „Lieferung erfolgt“.'
        : role === 'buyer'
          ? 'Das Geld liegt sicher im Treuhand-Konto. Warte auf die Lieferung. Ist alles in Ordnung, gib die Zahlung frei.'
          : 'Das Geld liegt sicher im Treuhand-Konto. Warte auf die Lieferung.';
    case 'FULFILLMENT':
      return role === 'buyer'
        ? 'Der Verkäufer hat geliefert. Prüfe die Ware. Passt alles, tippe auf „Freigabe an Verkäufer“, sonst auf „Probleme mit Admin“.'
        : 'Warte, bis der Käufer die Lieferung prüft und freigibt.';
    case 'RELEASE_REQUESTED':
      return role === 'seller'
        ? 'Gib jetzt deine Empfangsadresse an, damit die Auszahlung vorbereitet wird.'
        : 'Warte auf die Empfangsadresse des Verkäufers.';
    case 'REFUND_REQUESTED':
      return role === 'buyer' ? 'Gib jetzt deine Empfangsadresse für die Rückzahlung an.' : 'Warte auf die Empfangsadresse des Käufers.';
    case 'SIGNING':
      if (!signer) return 'Die Auszahlung wird gerade unterschrieben.';
      return sigCount >= 2
        ? 'Zwei Unterschriften liegen vor. Tippe auf „Transaktion senden“, um auszuzahlen.'
        : 'Lade die Auszahlungs-Datei in deine Wallet, prüfe Empfänger und Betrag, unterschreibe und schicke die Datei hier zurück („Signierte PSBT hochladen“).';
    case 'DISPUTED':
      return role === 'arbiter'
        ? 'Ein Streitfall wurde gemeldet. Tippe auf „Streitfall bearbeiten“.'
        : 'Der Schlichter wurde informiert. Du kannst eine Stellungnahme senden.';
    case 'ARBITRATION':
      return role === 'arbiter'
        ? 'Prüfe den Fall und entscheide: Auszahlung an Verkäufer oder Rückzahlung an Käufer.'
        : 'Der Schlichter prüft den Fall.';
    case 'BROADCAST':
      return 'Die Auszahlung ist gesendet. Nach der Bestätigung durch das Netzwerk ist der Handel abgeschlossen.';
    case 'COMPLETE':
      return 'Fertig! Der Verkäufer wurde ausgezahlt.';
    case 'REFUNDED':
      return 'Fertig! Der Käufer hat sein Geld zurück.';
    case 'NEEDS_REVIEW':
      return 'Etwas Ungewöhnliches ist passiert (siehe Grund). Es wird nichts automatisch ausgezahlt. Bitte Support kontaktieren.';
    default:
      return 'Dieser Handel ist beendet.';
  }
}

function roleStatus(t: TradeRow, parts: ParticipantRow[], r: Role): string {
  const p = parts.find((x) => x.role === r);
  if (!p) return '⏳ offen';
  if (t.status === 'AGREEMENT') return p.agreed_hash === t.agreement_hash ? '✅ zugestimmt' : '👋 beigetreten';
  if (t.status === 'KEY_SETUP') return p.address_verified_at ? '✅ Adresse bestätigt' : '🔑 Schlüssel/Prüfung';
  return '✅ bestätigt';
}

/** Trade overview as rich message (table); falls back to HTML automatically. */
export function tradeView(
  t: TradeRow,
  parts: ParticipantRow[],
  myRole: Role | null,
  me: ParticipantRow | null = null,
  sigCount = 0,
): MessageContent {
  const others = parts.filter((p) => p.role === 'mediator' || p.role === 'observer').length;
  const markup =
    `<h3>₿ Handel #${esc(t.id)} · ${esc(t.title)}</h3>` +
    `<blockquote>👉 ${b('Dein nächster Schritt:')} ${esc(nextStep(t, myRole, me, sigCount))}</blockquote>` +
    table(
      [
        ['Status', b(esc(STATE_LABEL_DE[t.status]))],
        ['Betrag', `${b(esc(formatBtc(BigInt(t.amount_sats))))} BTC`],
        ['Deine Rolle', myRole ? ROLE_LABEL_DE[myRole] : '–'],
        ['Servicegebühr', esc(formatBps(t.commission_bps))],
        ['Erstellt', time(t.created_at, 'dt')],
      ],
      false,
    ) +
    table([
      ['Beteiligte', 'Stand'],
      ['Käufer', roleStatus(t, parts, 'buyer')],
      ['Verkäufer', roleStatus(t, parts, 'seller')],
      ['Schlichter', roleStatus(t, parts, 'arbiter')],
    ]) +
    (others ? `<p>Weitere Teilnehmer (nur lesend): ${others}</p>` : '') +
    (t.status === 'NEEDS_REVIEW' && t.review_reason ? `<p>⚠️ Grund: ${esc(t.review_reason)}</p>` : '') +
    `<p>${i('Das Geld liegt nie beim Bot – nur im gemeinsamen Treuhand-Konto (2 von 3 Unterschriften nötig).')}</p>`;
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
