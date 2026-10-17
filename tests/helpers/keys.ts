/**
 * TEST-ONLY key material. Deterministic seeds generated here are public and
 * worthless; they must never be used outside automated tests.
 */
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { hex } from '@scure/base';
import { SIGNET } from '../../src/bitcoin/networks.ts';

const TPUB = { public: 0x043587cf, private: 0x04358394 };
export const ACCOUNT_PATH = "m/48'/1'/0'/2'";

export interface TestWallet {
  name: string;
  root: HDKey;
  account: HDKey;
  fingerprint: string;
  keyExpression: string;
  /** Private key of the escrow child <account>/0/0 — used only to sign in tests. */
  escrowPrivKey: Uint8Array;
}

export function testWallet(name: string, account = 0): TestWallet {
  const root = HDKey.fromMasterSeed(sha256(utf8ToBytes(`TEST-ONLY-NOT-A-REAL-WALLET:${name}`)), TPUB);
  const acc = root.derive(`m/48'/1'/${account}'/2'`);
  const fp = root.fingerprint.toString(16).padStart(8, '0');
  const child = acc.deriveChild(0).deriveChild(0);
  return {
    name,
    root,
    account: acc,
    fingerprint: fp,
    keyExpression: `[${fp}/48h/1h/${account}h/2h]${acc.publicExtendedKey}`,
    escrowPrivKey: child.privateKey!,
  };
}

export const NET = SIGNET;
export const toHex = (b: Uint8Array): string => hex.encode(b);
