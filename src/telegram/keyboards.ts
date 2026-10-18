import type { AppConfig } from '../config/env.ts';
import type { Button } from '../domain/context.ts';
import { can, type Role } from '../domain/permissions.ts';
import type { SessionRow, TradeRow, ParticipantRow } from '../database/repo.ts';

export function mainMenu(): Button[][] {
  return [
    [{ text: '➕ Neuen Handel starten', data: 'm:new', style: 'primary' }],
    [{ text: '📂 Meine Handel', data: 'm:trades' }],
    [
      { text: '❓ So funktioniert’s', data: 'm:help' },
      { text: '👛 Wallet einrichten', data: 'm:wallet' },
    ],
    [
      { text: '💸 Gebühren', data: 'm:fees' },
      { text: '🛡 Sicherheit', data: 'm:security' },
    ],
    [
      { text: '⚖️ Streitfälle', data: 'm:disputes' },
      { text: '🛟 Support', data: 'm:support' },
    ],
  ];
}

export function supportMenu(cfg: AppConfig): Button[][] {
  return [
    [{ text: 'Support kontaktieren', url: cfg.supportUrl, style: 'primary' }],
    [{ text: 'Probleme mit Admin', data: 'm:disputes', style: 'danger' }],
    [{ text: 'Sicherheitsinformationen', data: 'm:security' }],
    [{ text: 'Streitfallstatus', data: 'm:disputes' }],
  ];
}

/** Non-clickable hint about what the trade is waiting for. */
export function waitingHint(t: TradeRow, me: ParticipantRow | null, sigCount: number): string | null {
  switch (t.status) {
    case 'INVITING':
      return '⏳ Warte auf Teilnehmer';
    case 'AGREEMENT':
      return me?.agreed_hash === t.agreement_hash ? '✓ Du hast zugestimmt – warte auf andere' : null;
    case 'KEY_SETUP':
      return me?.address_verified_at ? '✓ Adresse bestätigt – warte auf andere' : null;
    case 'READY_TO_FUND':
      return '⏳ Warte auf Einzahlung';
    case 'FUNDING_SEEN':
      return '⏳ Warte auf Bestätigungen';
    case 'SIGNING':
      return `✍️ Signaturen: ${Math.min(sigCount, 2)} von 2`;
    case 'DISPUTED':
      return '⚖️ Warte auf Schlichter';
    case 'BROADCAST':
      return '⏳ Gesendet – warte auf Bestätigung';
    case 'NEEDS_REVIEW':
      return '⚠️ Manuelle Prüfung';
    default:
      return null;
  }
}

/** Buttons for the trade view; only actions the role may perform in the current state are shown. */
export function tradeButtons(
  cfg: AppConfig,
  t: TradeRow,
  me: ParticipantRow | null,
  role: Role | null,
  session: SessionRow | null,
  sigCount = 0,
): Button[][] {
  const id = t.id;
  const rows: Button[][] = [];
  const hint = waitingHint(t, me, sigCount);
  if (hint) rows.push([{ text: hint, disabled: true }]);

  const s = t.status;
  if (s === 'AGREEMENT' && can(role, 'agree_terms') && me?.agreed_hash !== t.agreement_hash) {
    rows.push([{ text: '✅ Bedingungen prüfen & akzeptieren', data: `t:${id}:terms`, style: 'success' }]);
  }
  if (s === 'KEY_SETUP' && can(role, 'register_key') && !me?.address_verified_at) {
    rows.push([
      { text: '🔑 Schlüssel senden / Adresse prüfen', data: `t:${id}:key`, style: 'primary' },
      { text: '👛 Wallet einrichten', data: 'm:wallet' },
    ]);
  }
  if (s === 'FUNDED' && can(role, 'mark_delivered'))
    rows.push([{ text: '📦 Lieferung erfolgt', data: `t:${id}:delivered`, style: 'success' }]);
  if ((s === 'FUNDED' || s === 'FULFILLMENT') && can(role, 'request_release'))
    rows.push([{ text: '✅ Freigabe an Verkäufer', data: `t:${id}:release`, style: 'success' }]);
  if ((s === 'FUNDED' || s === 'FULFILLMENT') && can(role, 'request_refund'))
    rows.push([{ text: '↩️ Rückerstattung an Käufer zustimmen', data: `t:${id}:refund` }]);
  if ((s === 'RELEASE_REQUESTED' && role === 'seller') || (s === 'REFUND_REQUESTED' && role === 'buyer')) {
    rows.push([{ text: '📥 Empfangsadresse angeben', data: `t:${id}:addr`, style: 'primary' }]);
  }
  if (s === 'SIGNING' && session && can(role, 'sign_psbt')) {
    if (session.status === 'open' && sigCount < 2)
      rows.push([
        { text: '✍️ Signierte PSBT hochladen', data: `s:${session.id}:up`, style: 'primary' },
        { text: 'PSBT anzeigen', data: `s:${session.id}:show` },
      ]);
    if ((session.status === 'open' && sigCount >= 2) || session.status === 'finalized')
      rows.push([{ text: '🚀 Transaktion senden', data: `s:${session.id}:bc`, style: 'success' }]);
  }
  if (['DISPUTED', 'ARBITRATION'].includes(s) && role === 'arbiter')
    rows.push([{ text: '⚖️ Streitfall bearbeiten', data: `d:${id}:take`, style: 'primary' }]);
  if (['DISPUTED', 'ARBITRATION'].includes(s) && (role === 'buyer' || role === 'seller'))
    rows.push([{ text: 'Stellungnahme senden', data: `d:${id}:ask` }]);

  rows.push([
    { text: 'Bedingungen', data: `t:${id}:terms` },
    { text: 'Teilnehmer', data: `t:${id}:parts` },
  ]);
  rows.push([
    { text: 'Gebühren', data: `t:${id}:fees` },
    { text: 'Zahlungsstatus', data: `t:${id}:pay` },
  ]);
  if (can(role, 'invite') && s !== 'CANCELLED' && s !== 'COMPLETE' && s !== 'REFUNDED')
    rows.push([{ text: 'Einladungen', data: `t:${id}:inv` }]);
  if (can(role, 'cancel_trade') && ['INVITING', 'AGREEMENT', 'KEY_SETUP', 'READY_TO_FUND'].includes(s))
    rows.push([{ text: 'Handel abbrechen', data: `t:${id}:cancel`, style: 'danger' }]);
  rows.push([
    { text: 'Probleme mit Admin', data: `t:${id}:dispute`, style: 'danger' },
    { text: 'Support', url: cfg.supportUrl },
  ]);
  return rows;
}
