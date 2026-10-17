import type { ChainUtxo } from '../blockchain/provider.ts';

/**
 * Funding policy (v1, decided before implementation):
 * - The escrow address is unique per trade, so every UTXO on it belongs to this trade.
 * - Sum of all UTXOs < amount           → PARTIAL: keep waiting, inform buyer, never proceed.
 * - Sum == amount, not all confirmed    → PENDING (FUNDING_SEEN). 0-conf is never final.
 * - Sum == amount, all ≥ minConf        → FUNDED.
 * - Sum > amount                        → OVERPAID: stop, NEEDS_REVIEW. No automatic refund of the excess.
 * The PSBT later spends exactly the UTXOs recorded at FUNDED time; nothing else is aggregated.
 */
export type FundingVerdict = 'none' | 'partial' | 'pending' | 'funded' | 'overpaid';

export interface FundingEvaluation {
  verdict: FundingVerdict;
  totalSats: bigint;
  confirmedSats: bigint;
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
  else if (total > expectedSats) verdict = 'overpaid';
  else verdict = confirmedSats === expectedSats ? 'funded' : 'pending';
  return { verdict, totalSats: total, confirmedSats, minConfirmations };
}
