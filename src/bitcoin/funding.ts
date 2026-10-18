import type { ChainUtxo } from '../blockchain/provider.ts';

/**
 * Funding policy (v2, operator decision 2026-10-18):
 * - The escrow address is unique per trade, so every UTXO on it belongs to this trade.
 * - Sum of all UTXOs < expected         → PARTIAL: keep waiting, inform buyer, never proceed.
 * - Sum ≥ expected, not all confirmed   → PENDING (FUNDING_SEEN). 0-conf is never final.
 * - Sum ≥ expected, all ≥ minConf       → FUNDED. An overpayment is accepted: the excess is part of
 *   the payout to the recipient (seller on release, buyer on refund); the service fee stays fixed.
 * The PSBT later spends exactly the UTXOs recorded at FUNDED time; nothing else is aggregated.
 */
export type FundingVerdict = 'none' | 'partial' | 'pending' | 'funded';

export interface FundingEvaluation {
  verdict: FundingVerdict;
  totalSats: bigint;
  confirmedSats: bigint;
  /** amount above the expected sum (0 if exact) */
  excessSats: bigint;
  minConfirmations: number;
}

export function confirmations(tipHeight: number, blockHeight: number | null): number {
  if (blockHeight === null || blockHeight > tipHeight) return 0;
  return tipHeight - blockHeight + 1;
}

export function evaluateFunding(expectedSats: bigint, utxos: ChainUtxo[], tipHeight: number, minConf: number): FundingEvaluation {
  const total = utxos.reduce((s, u) => s + u.valueSats, 0n);
  const confs = utxos.map((u) => (u.confirmed ? confirmations(tipHeight, u.blockHeight) : 0));
  const confirmedSats = utxos.reduce((s, u, i) => s + (confs[i]! >= minConf ? u.valueSats : 0n), 0n);
  const minConfirmations = confs.length ? Math.min(...confs) : 0;
  let verdict: FundingVerdict;
  if (utxos.length === 0) verdict = 'none';
  else if (total < expectedSats) verdict = 'partial';
  else verdict = confirmedSats === total ? 'funded' : 'pending';
  const excessSats = total > expectedSats ? total - expectedSats : 0n;
  return { verdict, totalSats: total, confirmedSats, excessSats, minConfirmations };
}
