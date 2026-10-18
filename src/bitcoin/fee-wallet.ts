import { p2wpkh } from '@scure/btc-signer';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { KeyError, loadHd } from './descriptor.ts';
import { canonicalXpubVersion, type NetworkParams } from './networks.ts';

/**
 * Operator fee wallet (watch-only). The operator exports the account xpub of a normal
 * single-signature wallet (BIP-84, native SegWit). Every trade gets its own fee address
 * <xpub>/0/<feeIndex>, so incoming fee payments are attributable without any shared address.
 * Only public keys are used; the operator spends fees with their own wallet.
 */

const b58c = base58check(sha256);
/** SLIP-132 BIP-84 account versions: vpub (testnet/signet), zpub (mainnet). */
const BIP84_VERSIONS: Record<NetworkParams['name'], number> = { signet: 0x045f1cf6, mainnet: 0x04b24746 };

export function parseFeeXpub(input: string, net: NetworkParams): string {
  // accept "[fp/84h/1h/0h]tpub…" or a bare tpub/vpub (xpub/zpub on mainnet)
  const bare = input
    .trim()
    .replace(/^\[[^\]]*\]/, '')
    .replace(/\/.*$/, '');
  let raw: Uint8Array;
  try {
    raw = b58c.decode(bare);
  } catch {
    throw new KeyError('COMMISSION_XPUB: ungültiger erweiterter Schlüssel');
  }
  if (raw.length !== 78) throw new KeyError('COMMISSION_XPUB: falsche Länge');
  const version = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
  if (version !== canonicalXpubVersion(net) && version !== BIP84_VERSIONS[net.name]) {
    throw new KeyError(`COMMISSION_XPUB passt nicht zum Netzwerk ${net.name} (öffentlicher Schlüssel erwartet)`);
  }
  if (raw[45] !== 0x02 && raw[45] !== 0x03) throw new KeyError('COMMISSION_XPUB muss ein öffentlicher Schlüssel sein');
  const canonical = new Uint8Array(raw);
  new DataView(canonical.buffer).setUint32(0, canonicalXpubVersion(net));
  return b58c.encode(canonical);
}

export function feeAddress(xpub: string, net: NetworkParams, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new KeyError('Gebührenindex ungültig');
  const child = loadHd(xpub, net).deriveChild(0).deriveChild(index);
  const addr = p2wpkh(child.publicKey!, net.btc).address;
  if (!addr) throw new KeyError('Gebührenadresse konnte nicht erzeugt werden');
  return addr;
}
