import { secp256k1 } from '@noble/curves/secp256k1.js';
import { SigHash, type Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { MAX_PSBT_BYTES } from '../config/constants.ts';
import type { SignerRole } from './multisig.ts';
import { parsePsbt, PsbtError, type EscrowScript, type SessionRef, type VerifiedSignatures } from './psbt.ts';

function eq(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a !== undefined && hex.encode(a) === hex.encode(b);
}

/** Verifies one ECDSA signature (DER + sighash byte) against the BIP-143 sighash we compute ourselves. */
function verifySig(tx: Transaction, idx: number, escrow: EscrowScript, amount: bigint, pubkey: Uint8Array, sig: Uint8Array): boolean {
  if (sig.length < 9 || sig.length > 73) return false;
  if (sig[sig.length - 1] !== SigHash.ALL) return false; // only SIGHASH_ALL is accepted
  const der = sig.subarray(0, sig.length - 1);
  const msg = tx.preimageWitnessV0(idx, escrow.witnessScript, SigHash.ALL, amount);
  try {
    return secp256k1.verify(der, msg, pubkey, { prehash: false, format: 'der', lowS: true });
  } catch {
    return false;
  }
}

/**
 * Fully re-validates an imported PSBT against the stored session before any use:
 * identical unsigned transaction (inputs, outputs, amounts, version, locktime),
 * expected witness UTXOs and scripts, only known signers, only SIGHASH_ALL,
 * every signature cryptographically valid. Throws on any deviation.
 */
export function verifyPsbtSignatures(bytes: Uint8Array, escrow: EscrowScript, session: SessionRef): VerifiedSignatures {
  if (bytes.length > MAX_PSBT_BYTES) throw new PsbtError('PSBT zu groß');
  const tx = parsePsbt(bytes);

  if (hex.encode(tx.unsignedTx) !== session.unsignedTxHex) {
    throw new PsbtError('PSBT weicht von der vereinbarten Transaktion ab (Inputs/Outputs/Beträge geändert)');
  }
  if (tx.inputsLength !== session.utxos.length) throw new PsbtError('Anzahl Inputs falsch');

  const byPub = new Map(escrow.signers.map((s) => [hex.encode(s.pubkey), s]));
  const perInput: Map<string, Uint8Array>[] = [];

  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const utxo = session.utxos[i]!;
    if (input.txid === undefined || hex.encode(input.txid) !== utxo.txid || input.index !== utxo.vout) {
      throw new PsbtError(`Input ${i}: falscher UTXO`);
    }
    if (input.witnessUtxo && (!eq(input.witnessUtxo.script, escrow.scriptPubKey) || input.witnessUtxo.amount !== utxo.valueSats)) {
      throw new PsbtError(`Input ${i}: Witness-UTXO manipuliert`);
    }
    if (input.witnessScript && !eq(input.witnessScript, escrow.witnessScript)) {
      throw new PsbtError(`Input ${i}: Witness-Script manipuliert`);
    }
    if (input.sighashType !== undefined && input.sighashType !== SigHash.ALL) {
      throw new PsbtError(`Input ${i}: unzulässiger Sighash-Typ`);
    }

    const found = new Map<string, Uint8Array>();
    const candidates: { pub?: Uint8Array; sig: Uint8Array }[] = [];
    for (const [pub, sig] of input.partialSig ?? []) candidates.push({ pub, sig });
    if (input.finalScriptWitness) {
      // Wallet already finalized: [<empty>, sig..., witnessScript]
      const w = input.finalScriptWitness;
      if (w.length < 3 || !eq(w[w.length - 1], escrow.witnessScript)) throw new PsbtError(`Input ${i}: finaler Witness ungültig`);
      for (const sig of w.slice(1, -1)) candidates.push({ sig });
    }

    for (const c of candidates) {
      const targets = c.pub ? [c.pub] : escrow.signers.map((s) => s.pubkey);
      let matched = false;
      for (const pub of targets) {
        const key = hex.encode(pub);
        if (!byPub.has(key)) throw new PsbtError(`Input ${i}: Signatur von unbekanntem Schlüssel`);
        if (verifySig(tx, i, escrow, utxo.valueSats, pub, c.sig)) {
          found.set(key, c.sig);
          matched = true;
          break;
        }
      }
      if (!matched) throw new PsbtError(`Input ${i}: ungültige Signatur`);
    }
    perInput.push(found);
  }

  const roles = new Set<SignerRole>();
  for (const s of escrow.signers) {
    const k = hex.encode(s.pubkey);
    if (perInput.every((m) => m.has(k))) roles.add(s.role);
  }
  return { perInput, roles };
}

/** Merges signatures from several validated imports (per input, per pubkey). */
export function mergeSignatures(a: Map<string, Uint8Array>[], b: Map<string, Uint8Array>[]): Map<string, Uint8Array>[] {
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => new Map([...(a[i] ?? new Map()), ...(b[i] ?? new Map())]));
}
