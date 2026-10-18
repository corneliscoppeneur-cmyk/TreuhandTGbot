import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { BIP48_PURPOSE, BIP48_SCRIPT_TYPE_P2WSH, ESCROW_CHAIN } from '../config/constants.ts';
import { canonicalXpubVersion, type NetworkParams } from './networks.ts';

const HARDENED = 0x80000000;

export class KeyError extends Error {
  override name = 'KeyError';
}

/** Public signer key with key origin, as registered by a participant. Never contains private material. */
export interface SignerKey {
  /** Master key fingerprint, 8 lowercase hex chars. */
  fingerprint: string;
  /** Derivation path from master to the account xpub, e.g. [48+H, 1+H, 0+H, 2+H]. */
  path: number[];
  /** Account xpub re-encoded with the network's canonical version (tpub/xpub). */
  xpub: string;
}

export function formatPath(path: number[]): string {
  return path.map((i) => (i >= HARDENED ? `${i - HARDENED}h` : String(i))).join('/');
}

function parsePath(raw: string): number[] {
  const parts = raw.split('/').filter((p) => p !== '' && p !== 'm');
  return parts.map((p) => {
    const m = /^(\d{1,10})(['hH]?)$/.exec(p);
    if (!m) throw new KeyError(`Ungültiges Pfadelement: ${p}`);
    const n = Number(m[1]);
    if (n >= HARDENED) throw new KeyError('Pfadindex zu groß');
    return m[2] ? n + HARDENED : n;
  });
}

const b58c = base58check(sha256);

/**
 * Parses a key expression "[fingerprint/48h/coin'/account'/2']xpub".
 * Only BIP-48 P2WSH account keys (depth 4, all hardened) are accepted so every
 * signer uses the same, wallet-compatible derivation scheme.
 */
export function parseSignerKey(input: string, net: NetworkParams): SignerKey {
  const text = input.trim().replace(/\s+/g, '');
  const m = /^\[([0-9a-fA-F]{8})((?:\/[0-9]+['hH]?)+)\]([1-9A-HJ-NP-Za-km-z]{100,120})(\/[0-9*/]*)?$/.exec(text);
  if (!m) {
    throw new KeyError('Format: [fingerprint/48h/' + net.coinType + 'h/0h/2h]tpub... (Key-Origin + erweiterter öffentlicher Schlüssel)');
  }
  const fingerprint = m[1]!.toLowerCase();
  const path = parsePath(m[2]!);
  const encoded = m[3]!;
  if (m[4] && m[4] !== '/0/*' && m[4] !== '/<0;1>/*') throw new KeyError('Nur Ableitung /0/* wird unterstützt');

  const expected = [BIP48_PURPOSE + HARDENED, net.coinType + HARDENED];
  if (path.length !== 4 || path[0] !== expected[0] || path[1] !== expected[1] || path[3] !== BIP48_SCRIPT_TYPE_P2WSH + HARDENED) {
    throw new KeyError(`Pfad muss m/48h/${net.coinType}h/<konto>h/2h sein (BIP-48, P2WSH)`);
  }
  if (path[2]! < HARDENED) throw new KeyError('Kontoindex muss gehärtet sein');

  let raw: Uint8Array;
  try {
    raw = b58c.decode(encoded);
  } catch {
    throw new KeyError('Erweiterter Schlüssel: Prüfsumme ungültig');
  }
  if (raw.length !== 78) throw new KeyError('Erweiterter Schlüssel hat falsche Länge');
  const version = new DataView(raw.buffer, raw.byteOffset).getUint32(0);
  const known = net.xpubVersions.find((v) => v.version === version);
  if (!known) {
    throw new KeyError(
      `Schlüssel passt nicht zum Netzwerk ${net.name}. Erlaubt: ${net.xpubVersions.map((v) => v.label).join(', ')}. Private Schlüssel (tprv/xprv) niemals senden!`,
    );
  }
  if (raw[45] !== 0x02 && raw[45] !== 0x03) {
    throw new KeyError('Kein öffentlicher Schlüssel. Private Schlüssel niemals senden!');
  }

  // Re-encode with canonical version so descriptors are portable.
  const canonical = new Uint8Array(raw);
  new DataView(canonical.buffer).setUint32(0, canonicalXpubVersion(net));
  const xpub = b58c.encode(canonical);

  const hd = loadHd(xpub, net);
  if (hd.depth !== 4) throw new KeyError('Schlüsseltiefe passt nicht zum Pfad (erwartet 4)');
  if (hd.index !== path[3]) throw new KeyError('Schlüsselindex passt nicht zum Pfad');

  return { fingerprint, path, xpub };
}

export function loadHd(xpub: string, net: NetworkParams): HDKey {
  try {
    // private version is irrelevant (never used); any distinct value works
    return HDKey.fromExtendedKey(xpub, { public: canonicalXpubVersion(net), private: 0x00000001 });
  } catch {
    throw new KeyError('Erweiterter öffentlicher Schlüssel ungültig');
  }
}

/** Child public key used for the escrow address: <xpub>/0/<index>. */
export function deriveChildPubkey(key: SignerKey, net: NetworkParams, index: number): Uint8Array {
  const child = loadHd(key.xpub, net).deriveChild(ESCROW_CHAIN).deriveChild(index);
  if (!child.publicKey) throw new KeyError('Ableitung fehlgeschlagen');
  return child.publicKey;
}

// ---- BIP-380 descriptor checksum ----

const INPUT_CHARSET = '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(c: bigint, val: bigint): bigint {
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ val;
  for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i]!;
  return c;
}

export function descriptorChecksum(desc: string): string {
  let c = 1n;
  let cls = 0n;
  let clscount = 0;
  for (const ch of desc) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) throw new KeyError('Ungültiges Zeichen im Descriptor');
    c = polymod(c, BigInt(pos & 31));
    cls = cls * 3n + BigInt(pos >> 5);
    if (++clscount === 3) {
      c = polymod(c, cls);
      cls = 0n;
      clscount = 0;
    }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let j = 0; j < 8; j++) c = polymod(c, 0n);
  c ^= 1n;
  let out = '';
  for (let j = 0; j < 8; j++) out += CHECKSUM_CHARSET[Number((c >> BigInt(5 * (7 - j))) & 31n)];
  return out;
}

export function withChecksum(desc: string): string {
  return `${desc}#${descriptorChecksum(desc)}`;
}

/** wsh(sortedmulti(2,...)) descriptor for the receive chain, importable into Sparrow / Bitcoin Core. */
export function multisigDescriptor(keys: SignerKey[], threshold: number): string {
  const parts = keys.map((k) => `[${k.fingerprint}/${formatPath(k.path)}]${k.xpub}/${ESCROW_CHAIN}/*`);
  return withChecksum(`wsh(sortedmulti(${threshold},${parts.join(',')}))`);
}
