import { SigHash, Transaction } from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { DUST_LIMIT_SATS } from '../config/constants.ts';
import { estimateVsize, feeForVsize } from './fee-estimator.ts';
import type { DerivedSigner, SignerRole } from './multisig.ts';
import { addressToScript, type NetworkParams } from './networks.ts';

export class PsbtError extends Error {
  override name = 'PsbtError';
}

/** Persisted, public-only description of the escrow script. */
export interface EscrowScript {
  scriptPubKey: Uint8Array;
  witnessScript: Uint8Array;
  signers: DerivedSigner[];
}

export interface FundingUtxo {
  txid: string;
  vout: number;
  valueSats: bigint;
}

export type PayoutKind = 'release' | 'refund';

export interface PayoutPlanInput {
  kind: PayoutKind;
  utxos: FundingUtxo[];
  /** Agreed trade amount — commission base. */
  amountSats: bigint;
  recipientAddress: string;
  commissionSats: bigint;
  commissionAddress: string;
  feeRateSatVb: number;
  maxFeeRateSatVb: number;
  maxFeePercent: number;
  net: NetworkParams;
}

export interface PayoutOutput {
  purpose: 'recipient' | 'commission';
  address: string;
  script: Uint8Array;
  valueSats: bigint;
}

export interface PayoutPlan {
  kind: PayoutKind;
  utxos: FundingUtxo[];
  totalInSats: bigint;
  outputs: PayoutOutput[];
  minerFeeSats: bigint;
  feeRateSatVb: number;
  vsize: number;
}

/** Computes outputs and fee for a payout. Pure integer arithmetic; refuses unsafe results. */
export function planPayout(p: PayoutPlanInput): PayoutPlan {
  if (p.utxos.length === 0) throw new PsbtError('Keine Funding-UTXOs');
  if (p.feeRateSatVb > p.maxFeeRateSatVb) {
    throw new PsbtError(`Gebührenrate ${p.feeRateSatVb} sat/vB über Maximum ${p.maxFeeRateSatVb}`);
  }
  const seen = new Set<string>();
  for (const u of p.utxos) {
    const k = `${u.txid}:${u.vout}`;
    if (seen.has(k)) throw new PsbtError('Doppelter UTXO');
    seen.add(k);
    if (u.valueSats <= 0n) throw new PsbtError('UTXO-Betrag ungültig');
  }
  const totalIn = p.utxos.reduce((s, u) => s + u.valueSats, 0n);

  const recipientScript = addressToScript(p.recipientAddress, p.net);
  const outputs: PayoutOutput[] = [{ purpose: 'recipient', address: p.recipientAddress.trim(), script: recipientScript, valueSats: 0n }];
  if (p.commissionSats > 0n) {
    if (p.commissionSats < DUST_LIMIT_SATS) throw new PsbtError('Provision unter Dust-Grenze');
    const commissionScript = addressToScript(p.commissionAddress, p.net);
    if (hex.encode(commissionScript) === hex.encode(recipientScript)) {
      throw new PsbtError('Empfänger darf nicht die Provisionsadresse sein');
    }
    outputs.push({
      purpose: 'commission',
      address: p.commissionAddress.trim(),
      script: commissionScript,
      valueSats: p.commissionSats,
    });
  }

  const vsize = estimateVsize(
    p.utxos.length,
    outputs.map((o) => o.script),
  );
  const minerFee = feeForVsize(vsize, p.feeRateSatVb);
  const maxFee = (p.amountSats * BigInt(p.maxFeePercent)) / 100n;
  if (minerFee > maxFee) throw new PsbtError(`Netzwerkgebühr ${minerFee} sat über Maximum ${maxFee} sat`);

  const recipientValue = totalIn - p.commissionSats - minerFee;
  if (recipientValue < DUST_LIMIT_SATS) throw new PsbtError('Auszahlungsbetrag unter Dust-Grenze');
  outputs[0]!.valueSats = recipientValue;

  return { kind: p.kind, utxos: p.utxos, totalInSats: totalIn, outputs, minerFeeSats: minerFee, feeRateSatVb: p.feeRateSatVb, vsize };
}

export interface BuiltPsbt {
  psbtBase64: string;
  /** Unsigned tx serialization; any later change to inputs/outputs changes it. */
  unsignedTxHex: string;
  txid: string;
}

function bip32Derivation(signers: DerivedSigner[]): [Uint8Array, { fingerprint: number; path: number[] }][] {
  return signers.map((s) => [s.pubkey, { fingerprint: parseInt(s.fingerprint, 16), path: s.fullPath }]);
}

/** Builds the unsigned PSBT (BIP-174) with all data external wallets need to verify and sign. */
export function buildPsbt(plan: PayoutPlan, escrow: EscrowScript): BuiltPsbt {
  const tx = new Transaction({ version: 2, lockTime: 0 });
  for (const u of plan.utxos) {
    tx.addInput({
      txid: u.txid,
      index: u.vout,
      witnessUtxo: { script: escrow.scriptPubKey, amount: u.valueSats },
      witnessScript: escrow.witnessScript,
      bip32Derivation: bip32Derivation(escrow.signers),
      sighashType: SigHash.ALL,
    });
  }
  for (const o of plan.outputs) tx.addOutput({ script: o.script, amount: o.valueSats });
  if (tx.fee !== plan.minerFeeSats) throw new PsbtError('Interne Gebührenprüfung fehlgeschlagen');
  return { psbtBase64: base64.encode(tx.toPSBT()), unsignedTxHex: hex.encode(tx.unsignedTx), txid: tx.id };
}

export function decodePsbtText(text: string): Uint8Array {
  const t = text.trim().replace(/\s+/g, '');
  try {
    if (/^[0-9a-fA-F]+$/.test(t) && t.startsWith('70736274ff')) return hex.decode(t.toLowerCase());
    return base64.decode(t);
  } catch {
    throw new PsbtError('PSBT konnte nicht gelesen werden (Base64 oder Hex erwartet)');
  }
}

export function parsePsbt(bytes: Uint8Array): Transaction {
  try {
    return Transaction.fromPSBT(bytes);
  } catch {
    throw new PsbtError('PSBT ist ungültig');
  }
}

export interface SessionRef {
  unsignedTxHex: string;
  utxos: FundingUtxo[];
}

export interface VerifiedSignatures {
  /** per input index: pubkey hex → signature (DER + sighash byte) */
  perInput: Map<string, Uint8Array>[];
  /** roles that have a valid signature on every input */
  roles: Set<SignerRole>;
}

/** Adds verified signatures to the session's base PSBT, finalizes and extracts the raw transaction. */
export function combineAndFinalize(
  basePsbtBase64: string,
  verified: Map<string, Uint8Array>[],
  escrow: EscrowScript,
  session: SessionRef,
): { rawTxHex: string; txid: string } {
  const tx = parsePsbt(base64.decode(basePsbtBase64));
  if (hex.encode(tx.unsignedTx) !== session.unsignedTxHex) throw new PsbtError('Basis-PSBT passt nicht zur Session');
  for (let i = 0; i < tx.inputsLength; i++) {
    const sigs = verified[i];
    if (!sigs || sigs.size < 2) throw new PsbtError(`Input ${i}: weniger als 2 gültige Signaturen`);
    const partialSig: [Uint8Array, Uint8Array][] = escrow.signers
      .filter((s) => sigs.has(hex.encode(s.pubkey)))
      .slice(0, 2)
      .map((s) => [s.pubkey, sigs.get(hex.encode(s.pubkey))!]);
    tx.updateInput(i, { partialSig }, true);
  }
  try {
    tx.finalize();
  } catch {
    throw new PsbtError('Finalisierung fehlgeschlagen');
  }
  const raw = tx.extract();
  const final = Transaction.fromRaw(raw);
  if (final.id !== tx.id) throw new PsbtError('Finale Transaktion weicht ab');
  return { rawTxHex: hex.encode(raw), txid: final.id };
}
