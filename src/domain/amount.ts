import { MAX_SATS, MIN_TRADE_SATS, SATS_PER_BTC } from '../config/constants.ts';

export class AmountError extends Error {
  override name = 'AmountError';
}

/**
 * Parses a BTC amount string ("0.01", "0,01", "1000 sat") into integer satoshis.
 * Never uses floating point.
 */
export function parseBtcAmount(input: string): bigint {
  const s = input.trim().replace(/\s+/g, ' ');
  const sat = /^(\d{1,16}) ?(sat|sats)$/i.exec(s);
  let value: bigint;
  if (sat) {
    value = BigInt(sat[1]!);
  } else {
    const m = /^(\d{1,8})(?:[.,](\d{1,8}))?(?: ?btc)?$/i.exec(s);
    if (!m) throw new AmountError('Betrag ungültig. Beispiel: 0,01 oder 1000000 sat');
    const whole = BigInt(m[1]!);
    const frac = BigInt((m[2] ?? '').padEnd(8, '0'));
    value = whole * SATS_PER_BTC + frac;
  }
  if (value < MIN_TRADE_SATS) throw new AmountError(`Mindestbetrag: ${formatBtc(MIN_TRADE_SATS)} BTC`);
  if (value > MAX_SATS) throw new AmountError('Betrag zu groß');
  return value;
}

/** Formats satoshis as "0,01000000" (German decimal comma, 8 places). */
export function formatBtc(sats: bigint): string {
  const neg = sats < 0n;
  const v = neg ? -sats : sats;
  const whole = v / SATS_PER_BTC;
  const frac = (v % SATS_PER_BTC).toString().padStart(8, '0');
  return `${neg ? '-' : ''}${whole},${frac}`;
}

export function formatSats(sats: bigint): string {
  return `${sats.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')} sat`;
}
