import { describe, expect, it } from 'vitest';
import * as bitcoinjs from 'bitcoinjs-lib';
import { descriptorChecksum, parseSignerKey } from '../../src/bitcoin/descriptor.ts';
import { buildMultisig, type RoleKey } from '../../src/bitcoin/multisig.ts';
import { MAINNET } from '../../src/bitcoin/networks.ts';
import { NET, testWallet, toHex } from '../helpers/keys.ts';

function roleKeys(names = ['buyer', 'seller', 'arbiter']): RoleKey[] {
  const roles = ['buyer', 'seller', 'arbiter'] as const;
  return roles.map((role, i) => ({ role, ...parseSignerKey(testWallet(names[i]!).keyExpression, NET) }));
}

describe('descriptor checksum (BIP-380)', () => {
  it('matches the BIP-380 test vector', () => {
    expect(descriptorChecksum('raw(deadbeef)')).toBe('89f8spxm');
  });
});

describe('parseSignerKey', () => {
  it('accepts a BIP-48 tpub key expression', () => {
    const w = testWallet('buyer');
    const k = parseSignerKey(w.keyExpression, NET);
    expect(k.fingerprint).toBe(w.fingerprint);
    expect(k.xpub.startsWith('tpub')).toBe(true);
  });

  it('accepts apostrophe hardened notation and /0/* suffix', () => {
    const w = testWallet('buyer');
    const expr = `[${w.fingerprint}/48'/1'/0'/2']${w.account.publicExtendedKey}/0/*`;
    expect(parseSignerKey(expr, NET).xpub).toBe(parseSignerKey(w.keyExpression, NET).xpub);
  });

  it('rejects private extended keys', () => {
    const w = testWallet('buyer');
    expect(() => parseSignerKey(`[${w.fingerprint}/48h/1h/0h/2h]${w.account.privateExtendedKey}`, NET)).toThrow();
  });

  it('rejects testnet keys on mainnet', () => {
    expect(() => parseSignerKey(testWallet('buyer').keyExpression, MAINNET)).toThrow(/Netzwerk|Pfad/);
  });

  it('rejects non BIP-48 paths', () => {
    const w = testWallet('buyer');
    expect(() => parseSignerKey(`[${w.fingerprint}/84h/1h/0h]${w.account.publicExtendedKey}`, NET)).toThrow(/Pfad/);
  });

  it('rejects a path that does not match the key depth/index', () => {
    const w = testWallet('buyer');
    const other = w.root.derive("m/48'/1'/0'").publicExtendedKey;
    expect(() => parseSignerKey(`[${w.fingerprint}/48h/1h/0h/2h]${other}`, NET)).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => parseSignerKey('hello', NET)).toThrow();
  });
});

describe('buildMultisig', () => {
  it('is deterministic and independent of key order', () => {
    const a = buildMultisig(roleKeys(), NET);
    const keys = roleKeys().reverse();
    const b = buildMultisig(keys, NET);
    expect(a.address).toBe(b.address);
    expect(a.descriptor).toBe(b.descriptor);
    expect(a.address.startsWith('tb1q')).toBe(true);
    expect(a.address.length).toBe(62);
  });

  it('matches an independent implementation (bitcoinjs-lib)', () => {
    const cfg = buildMultisig(roleKeys(), NET);
    const pubkeys = cfg.signers.map((s) => Buffer.from(s.pubkey));
    const sorted = [...pubkeys].sort(Buffer.compare);
    const p = bitcoinjs.payments.p2wsh({
      redeem: bitcoinjs.payments.p2ms({ m: 2, pubkeys: sorted, network: bitcoinjs.networks.testnet }),
      network: bitcoinjs.networks.testnet,
    });
    expect(p.address).toBe(cfg.address);
    expect(toHex(p.redeem!.output!)).toBe(toHex(cfg.witnessScript));
  });

  it('rejects duplicate keys and duplicate fingerprints', () => {
    const k = roleKeys();
    k[1] = { ...k[0]!, role: 'seller' };
    expect(() => buildMultisig(k, NET)).toThrow(/verschieden/);
    const same = testWallet('buyer');
    const k2 = roleKeys();
    k2[1] = { role: 'seller', ...parseSignerKey(testWallet('buyer', 1).keyExpression, NET) };
    expect(k2[1].fingerprint).toBe(same.fingerprint);
    expect(() => buildMultisig(k2, NET)).toThrow(/Fingerprint/);
  });

  it('requires all three roles', () => {
    const k = roleKeys();
    k[2] = { ...k[2]!, role: 'seller' };
    expect(() => buildMultisig(k, NET)).toThrow();
  });
});
