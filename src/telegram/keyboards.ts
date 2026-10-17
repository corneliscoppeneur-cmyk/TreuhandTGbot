import { InlineKeyboard } from 'grammy';
import type { AppConfig } from '../config/env.ts';
import type { Button } from '../domain/context.ts';
import { can, type Role } from '../domain/permissions.ts';
import type { SessionRow, TradeRow, ParticipantRow } from '../database/repo.ts';

export function toKeyboard(rows: Button[][] | undefined): InlineKeyboard | undefined {
  if (!rows || rows.length === 0) return undefined;
  const kb = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const b of row) {
      if ('url' in b) kb.url(b.text, b.url);
      else kb.text(b.text, b.data);
    }
    if (i < rows.length - 1) kb.row();
  });
  return kb;
}

export function mainMenu(): Button[][] {
  return [
    [{ text: 'Neuen Handel erstellen', data: 'm:new' }],
    [{ text: 'Meine Handelsfälle', data: 'm:trades' }],
    [{ text: 'Einladungen', data: 'm:invites' }],
    [{ text: 'Offene Streitfälle', data: 'm:disputes' }],
    [{ text: 'Gebühren', data: 'm:fees' }],
    [{ text: 'Hilfe und Sicherheit', data: 'm:help' }],
    [{ text: 'Support', data: 'm:support' }],
  ];
}

export function supportMenu(cfg: AppConfig): Button[][] {
  return [
    [{ text: 'Support kontaktieren', url: cfg.supportUrl }],
    [{ text: 'Probleme mit Admin', data: 'm:disputes' }],
    [{ text: 'Sicherheitsinformationen', data: 'm:security' }],
    [{ text: 'Streitfallstatus', data: 'm:disputes' }],
  ];
}

/** Buttons for the trade view; only actions the role may perform in the current state are shown. */
export function tradeButtons(
  cfg: AppConfig,
  t: TradeRow,
  me: ParticipantRow | null,
  role: Role | null,
  session: SessionRow | null,
): Button[][] {
  const id = t.id;
  const rows: Button[][] = [
    [{ text: 'Bedingungen', data: `t:${id}:terms` }, { text: 'Teilnehmer', data: `t:${id}:parts` }],
    [{ text: 'Gebühren', data: `t:${id}:fees` }, { text: 'Zahlungsstatus', data: `t:${id}:pay` }],
  ];
  const s = t.status;
  if (can(role, 'invite') && s !== 'CANCELLED' && s !== 'COMPLETE' && s !== 'REFUNDED') rows.push([{ text: 'Einladungen', data: `t:${id}:inv` }]);
  if (s === 'AGREEMENT' && can(role, 'agree_terms') && me?.agreed_hash !== t.agreement_hash) {
    rows.push([{ text: 'Bedingungen akzeptieren', data: `t:${id}:terms` }]);
  }
  if (s === 'KEY_SETUP' && can(role, 'register_key')) rows.push([{ text: 'Schlüssel / Adresse prüfen', data: `t:${id}:key` }]);
  if (s === 'FUNDED' && can(role, 'mark_delivered')) rows.push([{ text: 'Lieferung erfolgt', data: `t:${id}:delivered` }]);
  if ((s === 'FUNDED' || s === 'FULFILLMENT') && can(role, 'request_release')) rows.push([{ text: 'Freigabe an Verkäufer', data: `t:${id}:release` }]);
  if ((s === 'FUNDED' || s === 'FULFILLMENT') && can(role, 'request_refund')) rows.push([{ text: 'Rückerstattung an Käufer zustimmen', data: `t:${id}:refund` }]);
  if ((s === 'RELEASE_REQUESTED' && role === 'seller') || (s === 'REFUND_REQUESTED' && role === 'buyer')) {
    rows.push([{ text: 'Empfangsadresse angeben', data: `t:${id}:addr` }]);
  }
  if (s === 'SIGNING' && session && can(role, 'sign_psbt')) {
    if (session.status === 'open') rows.push([{ text: 'Signierte PSBT hochladen', data: `s:${session.id}:up` }, { text: 'PSBT erneut anzeigen', data: `s:${session.id}:show` }]);
    if (session.status === 'finalized') rows.push([{ text: 'Transaktion senden', data: `s:${session.id}:bc` }]);
  }
  if (['DISPUTED', 'ARBITRATION'].includes(s) && role === 'arbiter') rows.push([{ text: 'Streitfall bearbeiten', data: `d:${id}:take` }]);
  if (['DISPUTED', 'ARBITRATION'].includes(s) && (role === 'buyer' || role === 'seller')) rows.push([{ text: 'Stellungnahme senden', data: `d:${id}:ask` }]);
  if (can(role, 'cancel_trade') && ['INVITING', 'AGREEMENT', 'KEY_SETUP', 'READY_TO_FUND'].includes(s)) rows.push([{ text: 'Handel abbrechen', data: `t:${id}:cancel` }]);
  rows.push([{ text: 'Probleme mit Admin', data: `t:${id}:dispute` }, { text: 'Support', url: cfg.supportUrl }]);
  return rows;
}
