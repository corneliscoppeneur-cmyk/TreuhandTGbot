/** TEST-ONLY helpers: builds an escrow and signs PSBTs with deterministic test keys (simulates external wallets). */
import { Transaction, p2wpkh } from '@scure/btc-signer';
import { base64 } from '@scure/base';
import { parseSignerKey } from '../../src/bitcoin/descriptor.ts';
import { buildMultisig, type MultisigConfig, type SignerRole } from '../../src/bitcoin/multisig.ts';
import { buildPsbt, planPayout, type EscrowScript, type FundingUtxo, type PayoutKind } from '../../src/bitcoin/psbt.ts';
import { NET, testWallet, type TestWallet } from './keys.ts';

export const wallets: Record<SignerRole, TestWallet> = {
  buyer: testWallet('buyer'),
  seller: testWallet('seller'),
  arbiter: testWallet('arbiter'),
};

export function testMultisig(): MultisigConfig {
  return buildMultisig(
    (['buyer', 'seller', 'arbiter'] as const).map((role) => ({ role, ...parseSignerKey(wallets[role].keyExpression, NET) })),
    NET,
  );
}

export function escrowOf(cfg: MultisigConfig): EscrowScript {
  return { scriptPubKey: cfg.scriptPubKey, witnessScript: cfg.witnessScript, signers: cfg.signers };
}

/** Deterministic test address (p2wpkh of a test key). */
export function testAddress(name: string): string {
  return p2wpkh(testWallet(name).account.deriveChild(0).deriveChild(5).publicKey!, NET.btc).address!;
}

export const UTXO: FundingUtxo = {
  txid: 'aa'.repeat(32),
  vout: 1,
  valueSats: 1_000_000n,
};

export function testPsbt(kind: PayoutKind = 'release', utxos: FundingUtxo[] = [UTXO]) {
  const cfg = testMultisig();
  const plan = planPayout({
    kind,
    utxos,
    amountSats: utxos.reduce((s, u) => s + u.valueSats, 0n),
    recipientAddress: testAddress(kind === 'release' ? 'seller-payout' : 'buyer-refund'),
    commissionSats: kind === 'release' ? 10_000n : 0n,
    commissionAddress: testAddress('operator'),
    feeRateSatVb: 2,
    maxFeeRateSatVb: 50,
    maxFeePercent: 5,
    net: NET,
  });
  const built = buildPsbt(plan, escrowOf(cfg));
  return { cfg, plan, built, escrow: escrowOf(cfg), session: { unsignedTxHex: built.unsignedTxHex, utxos } };
}

/** Simulates an external wallet: signs every input with the role's escrow child key. */
export function signAs(psbtBase64: string, role: SignerRole): string {
  const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
  for (let i = 0; i < tx.inputsLength; i++) tx.signIdx(wallets[role].escrowPrivKey, i);
  return base64.encode(tx.toPSBT());
}
