import { describe, expect, it } from 'vitest';
import * as bitcoinjs from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { Transaction } from '@scure/btc-signer';
import { base64, hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { combineAndFinalize, planPayout, PsbtError } from '../../src/bitcoin/psbt.ts';
import { mergeSignatures, verifyPsbtSignatures } from '../../src/bitcoin/psbt-validator.ts';
import { estimateVsize, pickFeeRate } from '../../src/bitcoin/fee-estimator.ts';
import { commissionSats } from '../../src/domain/fees.ts';
import { NET, testWallet } from '../helpers/keys.ts';
import { signAs, testAddress, testPsbt, UTXO } from '../helpers/escrow.ts';
import type { SignerRole } from '../../src/bitcoin/multisig.ts';

bitcoinjs.initEccLib(ecc);

const b = (s: string) => base64.decode(s);

describe('payout plan', () => {
  it('computes recipient = in - commission - fee in integer sats', () => {
    const { plan } = testPsbt('release');
    const commission = plan.outputs.find((o) => o.purpose === 'commission')!.valueSats;
    const recipient = plan.outputs.find((o) => o.purpose === 'recipient')!.valueSats;
    expect(commission).toBe(10_000n);
    expect(recipient + commission + plan.minerFeeSats).toBe(1_000_000n);
    expect(plan.minerFeeSats).toBe(BigInt(plan.vsize * 2));
  });

  it('refund has no commission output by default', () => {
    const { plan } = testPsbt('refund');
    expect(plan.outputs).toHaveLength(1);
  });

  it('refuses fee rate above maximum and fee above max percent', () => {
    const base = {
      kind: 'release' as const,
      utxos: [UTXO],
      amountSats: UTXO.valueSats,
      recipientAddress: testAddress('x'),
      commissionSats: 0n,
      commissionAddress: testAddress('op'),
      maxFeeRateSatVb: 50,
      maxFeePercent: 1,
      net: NET,
    };
    expect(() => planPayout({ ...base, feeRateSatVb: 51 })).toThrow(PsbtError);
    expect(() => planPayout({ ...base, utxos: [{ ...UTXO, valueSats: 20_000n }], amountSats: 20_000n, feeRateSatVb: 40 })).toThrow(/Maximum/);
  });

  it('refuses dust payouts and mainnet addresses on signet', () => {
    expect(() =>
      planPayout({
        kind: 'release',
        utxos: [{ ...UTXO, valueSats: 600n }],
        amountSats: 600n,
        recipientAddress: testAddress('x'),
        commissionSats: 0n,
        commissionAddress: testAddress('op'),
        feeRateSatVb: 1,
        maxFeeRateSatVb: 50,
        maxFeePercent: 50,
        net: NET,
      }),
    ).toThrow(/Dust/);
    expect(() =>
      planPayout({
        kind: 'release',
        utxos: [UTXO],
        amountSats: UTXO.valueSats,
        recipientAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
        commissionSats: 0n,
        commissionAddress: testAddress('op'),
        feeRateSatVb: 1,
        maxFeeRateSatVb: 50,
        maxFeePercent: 5,
        net: NET,
      }),
    ).toThrow(/Netzwerk/);
  });

  it('commission drops below dust', () => {
    expect(commissionSats(1_000_000n, 100)).toBe(10_000n);
    expect(commissionSats(50_000n, 100)).toBe(0n);
  });

  it('fee rate picker rounds up and falls back', () => {
    expect(pickFeeRate({ '1': 10.2, '6': 3.1, '144': 1.0 }, 6)).toBe(4);
    expect(pickFeeRate({}, 6)).toBe(1);
    expect(estimateVsize(1, [new Uint8Array(22)])).toBe(11 + 105 + 31);
  });
});

const valid: [SignerRole, SignerRole][] = [
  ['buyer', 'seller'],
  ['buyer', 'arbiter'],
  ['seller', 'arbiter'],
];

describe('signature combinations', () => {
  for (const [r1, r2] of valid) {
    it(`${r1} + ${r2} finalizes`, () => {
      const { built, escrow, session } = testPsbt('release', [UTXO, { ...UTXO, vout: 2, valueSats: 500_000n }]);
      const v1 = verifyPsbtSignatures(b(signAs(built.psbtBase64, r1)), escrow, session);
      const v2 = verifyPsbtSignatures(b(signAs(built.psbtBase64, r2)), escrow, session);
      expect([...v1.roles]).toEqual([r1]);
      const merged = mergeSignatures(v1.perInput, v2.perInput);
      const { rawTxHex, txid } = combineAndFinalize(built.psbtBase64, merged, escrow, session);
      expect(txid).toBe(built.txid);
      const final = Transaction.fromRaw(hex.decode(rawTxHex));
      expect(final.inputsLength).toBe(2);
    });
  }

  for (const r of ['buyer', 'seller', 'arbiter'] as const) {
    it(`only ${r} cannot finalize`, () => {
      const { built, escrow, session } = testPsbt();
      const v = verifyPsbtSignatures(b(signAs(built.psbtBase64, r)), escrow, session);
      expect(() => combineAndFinalize(built.psbtBase64, v.perInput, escrow, session)).toThrow(/2 gültige/);
    });
  }

  it('the same signer twice does not count as two', () => {
    const { built, escrow, session } = testPsbt();
    const v1 = verifyPsbtSignatures(b(signAs(built.psbtBase64, 'buyer')), escrow, session);
    const v2 = verifyPsbtSignatures(b(signAs(built.psbtBase64, 'buyer')), escrow, session);
    expect(() => combineAndFinalize(built.psbtBase64, mergeSignatures(v1.perInput, v2.perInput), escrow, session)).toThrow();
  });

  it('rejects a signature from an unknown key', () => {
    const { built, escrow, session } = testPsbt();
    const tx = Transaction.fromPSBT(b(built.psbtBase64));
    const stranger = testWallet('stranger');
    // inject stranger as partialSig by signing with a key that is not in the script
    const msg = tx.preimageWitnessV0(0, escrow.witnessScript, 1, UTXO.valueSats);
    const sig = secp256k1.sign(msg, stranger.escrowPrivKey, { prehash: false, format: 'der' });
    const pub = secp256k1.getPublicKey(stranger.escrowPrivKey, true);
    tx.updateInput(0, { partialSig: [[pub, new Uint8Array([...sig, 1])]] }, true);
    expect(() => verifyPsbtSignatures(tx.toPSBT(), escrow, session)).toThrow(/unbekannt/);
  });

  it('rejects a manipulated signature', () => {
    const { built, escrow, session } = testPsbt();
    const signedTx = Transaction.fromPSBT(b(signAs(built.psbtBase64, 'buyer')));
    const [pub, sig] = signedTx.getInput(0).partialSig![0]!;
    const tx = Transaction.fromPSBT(b(built.psbtBase64));
    const bad = new Uint8Array(sig);
    bad[10] = bad[10]! ^ 0x01;
    tx.updateInput(0, { partialSig: [[pub, bad]] }, true);
    expect(() => verifyPsbtSignatures(tx.toPSBT(), escrow, session)).toThrow(/ungültig/);
  });

  it('rejects SIGHASH other than ALL', () => {
    const { built, escrow, session } = testPsbt();
    const signedTx = Transaction.fromPSBT(b(signAs(built.psbtBase64, 'buyer')));
    const [pub, sig] = signedTx.getInput(0).partialSig![0]!;
    const tx = Transaction.fromPSBT(b(built.psbtBase64));
    const changed = new Uint8Array(sig);
    changed[changed.length - 1] = 0x83; // SINGLE|ANYONECANPAY
    tx.updateInput(0, { partialSig: [[pub, changed]] }, true);
    expect(() => verifyPsbtSignatures(tx.toPSBT(), escrow, session)).toThrow();
  });

  it('rejects a manipulated transaction (changed output)', () => {
    const { built, escrow, session } = testPsbt();
    const tx = Transaction.fromPSBT(b(built.psbtBase64));
    tx.updateOutput(0, { amount: 999_000n });
    expect(() => verifyPsbtSignatures(tx.toPSBT(), escrow, session)).toThrow(/weicht/);
  });

  it('rejects an extra output and an extra input', () => {
    const { built, escrow, session } = testPsbt();
    const tx = Transaction.fromPSBT(b(built.psbtBase64));
    tx.addOutputAddress(testAddress('thief'), 1000n, NET.btc);
    expect(() => verifyPsbtSignatures(tx.toPSBT(), escrow, session)).toThrow(/weicht/);
    const tx2 = Transaction.fromPSBT(b(built.psbtBase64));
    tx2.addInput({ txid: 'bb'.repeat(32), index: 0 });
    expect(() => verifyPsbtSignatures(tx2.toPSBT(), escrow, session)).toThrow(/weicht/);
  });

  it('rejects a PSBT from another (stale) session', () => {
    const a = testPsbt('release');
    const r = testPsbt('refund');
    expect(() => verifyPsbtSignatures(b(signAs(r.built.psbtBase64, 'buyer')), a.escrow, a.session)).toThrow(/weicht/);
  });

  it('rejects garbage input', () => {
    const { escrow, session } = testPsbt();
    expect(() => verifyPsbtSignatures(new Uint8Array([1, 2, 3]), escrow, session)).toThrow(PsbtError);
  });
});

describe('independent cross-check with bitcoinjs-lib', () => {
  it('bitcoinjs validates our signatures and finalizes to the same txid', () => {
    const { built } = testPsbt();
    const signed = signAs(signAs(built.psbtBase64, 'buyer'), 'arbiter');
    const p = bitcoinjs.Psbt.fromBase64(signed, { network: bitcoinjs.networks.testnet });
    const validator = (pubkey: Uint8Array, msghash: Uint8Array, signature: Uint8Array) => ecc.verify(msghash, pubkey, signature);
    expect(p.validateSignaturesOfAllInputs(validator)).toBe(true);
    p.finalizeAllInputs();
    expect(p.extractTransaction().getId()).toBe(built.txid);
  });

  it('accepts a PSBT finalized by an external wallet (bitcoinjs)', () => {
    const { built, escrow, session } = testPsbt();
    const signed = signAs(signAs(built.psbtBase64, 'seller'), 'buyer');
    const p = bitcoinjs.Psbt.fromBase64(signed, { network: bitcoinjs.networks.testnet });
    p.finalizeAllInputs();
    const v = verifyPsbtSignatures(b(p.toBase64()), escrow, session);
    expect(v.roles).toEqual(new Set(['buyer', 'seller']));
  });
});
