import { p2ms, p2wsh } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { ESCROW_CHAIN, ESCROW_INDEX } from '../config/constants.ts';
import { deriveChildPubkey, KeyError, multisigDescriptor, type SignerKey } from './descriptor.ts';
import type { NetworkParams } from './networks.ts';

export const MULTISIG_THRESHOLD = 2;
export type SignerRole = 'buyer' | 'seller' | 'arbiter';
export const SIGNER_ROLES: readonly SignerRole[] = ['buyer', 'seller', 'arbiter'];

export interface RoleKey extends SignerKey {
  role: SignerRole;
  /** Pre-derived <xpub>/0/0 key (derived by deriveChildPubkey at registration) to spread CPU cost. */
  escrowPubkey?: Uint8Array;
}

export interface DerivedSigner {
  role: SignerRole;
  fingerprint: string;
  /** Full path from master to the escrow child key. */
  fullPath: number[];
  pubkey: Uint8Array;
}

export interface MultisigConfig {
  address: string;
  scriptPubKey: Uint8Array;
  witnessScript: Uint8Array;
  descriptor: string;
  /** Signers sorted in script order (BIP-67 lexicographic pubkey order). */
  signers: DerivedSigner[];
}

function cmp(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * Deterministic 2-of-3 P2WSH multisig. Keys are sorted by BIP-67 (sortedmulti), so
 * the result does not depend on registration order and every signer can reproduce it.
 */
export function buildMultisig(keys: RoleKey[], net: NetworkParams): MultisigConfig {
  if (keys.length !== 3) throw new KeyError('Genau drei Signierschlüssel erforderlich');
  const roles = new Set(keys.map((k) => k.role));
  if (roles.size !== 3 || !SIGNER_ROLES.every((r) => roles.has(r))) {
    throw new KeyError('Käufer, Verkäufer und Schlichter brauchen je einen Schlüssel');
  }
  if (new Set(keys.map((k) => k.xpub)).size !== 3) throw new KeyError('Schlüssel müssen verschieden sein');
  if (new Set(keys.map((k) => k.fingerprint)).size !== 3) {
    throw new KeyError('Master-Fingerprints müssen verschieden sein (unabhängige Wallets)');
  }

  const signers: DerivedSigner[] = keys.map((k) => ({
    role: k.role,
    fingerprint: k.fingerprint,
    fullPath: [...k.path, ESCROW_CHAIN, ESCROW_INDEX],
    pubkey: k.escrowPubkey ?? deriveChildPubkey(k, net, ESCROW_INDEX),
  }));
  if (new Set(signers.map((s) => hex.encode(s.pubkey))).size !== 3) throw new KeyError('Abgeleitete Schlüssel kollidieren');
  signers.sort((a, b) => cmp(a.pubkey, b.pubkey));

  const ms = p2ms(
    MULTISIG_THRESHOLD,
    signers.map((s) => s.pubkey),
  );
  const pay = p2wsh(ms, net.btc);
  if (!pay.address || !pay.witnessScript) throw new KeyError('Multisig-Erstellung fehlgeschlagen');

  const ordered = [...keys].sort((a, b) => SIGNER_ROLES.indexOf(a.role) - SIGNER_ROLES.indexOf(b.role));
  return {
    address: pay.address,
    scriptPubKey: pay.script,
    witnessScript: pay.witnessScript,
    descriptor: multisigDescriptor(ordered, MULTISIG_THRESHOLD),
    signers,
  };
}
