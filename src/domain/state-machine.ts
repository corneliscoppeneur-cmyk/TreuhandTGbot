/** Explicit trade state machine. Every status change in the code base goes through assertTransition(). */

export const TRADE_STATES = [
  'DRAFT',
  'INVITING',
  'AGREEMENT',
  'KEY_SETUP',
  'READY_TO_FUND',
  'FUNDING_SEEN',
  'FUNDED',
  'FULFILLMENT',
  'RELEASE_REQUESTED',
  'REFUND_REQUESTED',
  'SIGNING',
  'DISPUTED',
  'ARBITRATION',
  'BROADCAST',
  'COMPLETE',
  'REFUNDED',
  'CANCELLED',
  'FAILED',
  'NEEDS_REVIEW',
] as const;
export type TradeState = (typeof TRADE_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TradeState> = new Set(['COMPLETE', 'REFUNDED', 'CANCELLED', 'FAILED']);

/** States in which BTC may sit in the escrow address (cancel is forbidden, funds must be paid out). */
export const FUNDS_AT_RISK_STATES: ReadonlySet<TradeState> = new Set([
  'FUNDING_SEEN',
  'FUNDED',
  'FULFILLMENT',
  'RELEASE_REQUESTED',
  'REFUND_REQUESTED',
  'SIGNING',
  'DISPUTED',
  'ARBITRATION',
  'BROADCAST',
  'NEEDS_REVIEW',
]);

/** Parameters (parties, keys, script, amount, fees, terms) are frozen from READY_TO_FUND on. */
export const PARAMS_LOCKED_STATES: ReadonlySet<TradeState> = new Set(
  TRADE_STATES.filter((s) => !['DRAFT', 'INVITING', 'AGREEMENT', 'KEY_SETUP', 'CANCELLED'].includes(s)),
);

const T: Record<TradeState, TradeState[]> = {
  DRAFT: ['INVITING', 'CANCELLED'],
  INVITING: ['AGREEMENT', 'CANCELLED'],
  AGREEMENT: ['KEY_SETUP', 'INVITING', 'CANCELLED'],
  KEY_SETUP: ['READY_TO_FUND', 'CANCELLED'],
  READY_TO_FUND: ['FUNDING_SEEN', 'FUNDED', 'CANCELLED', 'NEEDS_REVIEW'],
  FUNDING_SEEN: ['FUNDED', 'READY_TO_FUND', 'NEEDS_REVIEW', 'DISPUTED'],
  FUNDED: ['FULFILLMENT', 'RELEASE_REQUESTED', 'REFUND_REQUESTED', 'DISPUTED', 'NEEDS_REVIEW'],
  FULFILLMENT: ['RELEASE_REQUESTED', 'REFUND_REQUESTED', 'DISPUTED', 'NEEDS_REVIEW'],
  RELEASE_REQUESTED: ['SIGNING', 'DISPUTED', 'FUNDED', 'NEEDS_REVIEW'],
  REFUND_REQUESTED: ['SIGNING', 'DISPUTED', 'FUNDED', 'NEEDS_REVIEW'],
  SIGNING: ['BROADCAST', 'DISPUTED', 'FUNDED', 'ARBITRATION', 'NEEDS_REVIEW'],
  DISPUTED: ['ARBITRATION', 'NEEDS_REVIEW'],
  ARBITRATION: ['RELEASE_REQUESTED', 'REFUND_REQUESTED', 'SIGNING', 'NEEDS_REVIEW'],
  BROADCAST: ['COMPLETE', 'REFUNDED', 'NEEDS_REVIEW'],
  NEEDS_REVIEW: ['FUNDED', 'READY_TO_FUND', 'ARBITRATION', 'COMPLETE', 'REFUNDED', 'FAILED'],
  COMPLETE: [],
  REFUNDED: [],
  CANCELLED: [],
  FAILED: [],
};

export class TransitionError extends Error {
  override name = 'TransitionError';
}

export function canTransition(from: TradeState, to: TradeState): boolean {
  return T[from].includes(to);
}

export function assertTransition(from: TradeState, to: TradeState): void {
  if (!canTransition(from, to)) throw new TransitionError(`Unzulässiger Statuswechsel ${from} → ${to}`);
}

export function isTradeState(s: string): s is TradeState {
  return (TRADE_STATES as readonly string[]).includes(s);
}

export const STATE_LABEL_DE: Record<TradeState, string> = {
  DRAFT: 'ENTWURF',
  INVITING: 'EINLADUNGEN OFFEN',
  AGREEMENT: 'BEDINGUNGEN BESTÄTIGEN',
  KEY_SETUP: 'SCHLÜSSEL EINRICHTEN',
  READY_TO_FUND: 'WARTET AUF EINZAHLUNG',
  FUNDING_SEEN: 'EINZAHLUNG GESEHEN (UNBESTÄTIGT)',
  FUNDED: 'FINANZIERT',
  FULFILLMENT: 'LIEFERUNG GEMELDET',
  RELEASE_REQUESTED: 'FREIGABE ANGEFORDERT',
  REFUND_REQUESTED: 'RÜCKERSTATTUNG ANGEFORDERT',
  SIGNING: 'SIGNATUR LÄUFT',
  DISPUTED: 'STREITFALL',
  ARBITRATION: 'SCHLICHTUNG',
  BROADCAST: 'GESENDET, WARTET AUF BESTÄTIGUNG',
  COMPLETE: 'ABGESCHLOSSEN',
  REFUNDED: 'ERSTATTET',
  CANCELLED: 'ABGEBROCHEN',
  FAILED: 'FEHLGESCHLAGEN',
  NEEDS_REVIEW: 'PRÜFUNG ERFORDERLICH',
};
