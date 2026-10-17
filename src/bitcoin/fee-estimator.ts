/**
 * Conservative vsize estimation for spending 2-of-3 P2WSH inputs.
 * Over-estimating by a few vbytes is intended: it can only make the fee slightly higher, never too low.
 */

/** version(4) + locktime(4) + in/out counts(2) + segwit marker/flag(0.5) → rounded up. */
const TX_OVERHEAD_VB = 11;
/** outpoint(36) + scriptSig len(1) + sequence(4). */
const INPUT_BASE_VB = 41;
/** witness: count(1) + empty(1) + 2×(len 1 + DER sig ≤72 + sighash 1) + len(1) + script(105) = 256 WU = 64 vB. */
const INPUT_WITNESS_VB = 64;

export function estimateVsize(inputCount: number, outputScripts: Uint8Array[]): number {
  if (!Number.isInteger(inputCount) || inputCount < 1) throw new Error('inputCount must be >= 1');
  const outputs = outputScripts.reduce((sum, s) => sum + 8 + 1 + s.length, 0);
  return TX_OVERHEAD_VB + inputCount * (INPUT_BASE_VB + INPUT_WITNESS_VB) + outputs;
}

/** fee = ceil(vsize × rate) in integer sats. */
export function feeForVsize(vsize: number, feeRateSatVb: number): bigint {
  if (!Number.isInteger(feeRateSatVb) || feeRateSatVb < 1) throw new Error('fee rate must be integer >= 1');
  return BigInt(vsize) * BigInt(feeRateSatVb);
}

/** Picks a fee rate (sat/vB, integer, rounded up) from an Esplora /fee-estimates map for the target. */
export function pickFeeRate(estimates: Record<string, number>, targetBlocks: number): number {
  const keys = Object.keys(estimates)
    .map(Number)
    .filter((k) => Number.isFinite(k) && k > 0)
    .sort((a, b) => a - b);
  // first target >= wanted, else the largest available
  const key = keys.find((k) => k >= targetBlocks) ?? keys[keys.length - 1];
  const rate = key === undefined ? undefined : estimates[String(key)];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return 1;
  return Math.max(1, Math.ceil(rate));
}
