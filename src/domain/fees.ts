import { DUST_LIMIT_SATS } from '../config/constants.ts';

/**
 * Fee policy (v1), shown to and accepted by all parties before funding:
 * - Service commission: basis points of the agreed trade amount, a separate PSBT output.
 *   Release: DEFAULT_COMMISSION_BPS. Refund: REFUND_COMMISSION_BPS (default 0).
 *   Dispute outcomes use the same rule as the resulting payout (release or refund).
 * - Network (miner) fee: always paid by the payout recipient (seller on release, buyer on refund).
 * - Commission below the dust limit is dropped (no output) and shown as 0.
 * - Fee rate above MAX_FEE_RATE_SAT_VB or miner fee above MAX_FEE_PERCENT of the amount: refused,
 *   the PSBT is not built; parties must retry later.
 * - Any change of outputs or fees requires a new PSBT session and new signatures.
 */

export function commissionSats(amountSats: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('invalid bps');
  const c = (amountSats * BigInt(bps)) / 10_000n;
  return c < DUST_LIMIT_SATS ? 0n : c;
}

export function formatBps(bps: number): string {
  return `${Math.floor(bps / 100)},${String(bps % 100).padStart(2, '0')} %`;
}
