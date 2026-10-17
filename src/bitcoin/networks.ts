import { Address, NETWORK, OutScript, TEST_NETWORK } from '@scure/btc-signer';
import type { BitcoinNetworkName } from '../config/env.ts';

export interface NetworkParams {
  name: BitcoinNetworkName;
  /** Address encoding params for @scure/btc-signer. Signet shares testnet encodings. */
  btc: typeof NETWORK;
  /** BIP-32 extended public key version bytes accepted for this network. */
  xpubVersions: { label: string; version: number }[];
  /** BIP-44 coin type (1 = all testnets). */
  coinType: number;
}

export const SIGNET: NetworkParams = {
  name: 'signet',
  btc: TEST_NETWORK,
  xpubVersions: [
    { label: 'tpub', version: 0x043587cf },
    // SLIP-132 testnet P2WSH multisig (Sparrow/Electrum may export this).
    { label: 'Vpub', version: 0x02575483 },
  ],
  coinType: 1,
};

export const MAINNET: NetworkParams = {
  name: 'mainnet',
  btc: NETWORK,
  xpubVersions: [
    { label: 'xpub', version: 0x0488b21e },
    { label: 'Zpub', version: 0x02aa7ed3 },
  ],
  coinType: 0,
};

/** Canonical BIP-32 public version used inside descriptors. */
export function canonicalXpubVersion(net: NetworkParams): number {
  return net.xpubVersions[0]!.version;
}

export function getNetwork(name: BitcoinNetworkName): NetworkParams {
  return name === 'mainnet' ? MAINNET : SIGNET;
}

export class AddressError extends Error {
  override name = 'AddressError';
}

/**
 * Validates an address for the given network and returns its output script.
 * Only standard SegWit / legacy single-key and script-hash outputs are allowed as payout targets.
 */
export function addressToScript(address: string, net: NetworkParams): Uint8Array {
  const trimmed = address.trim();
  if (trimmed.length < 14 || trimmed.length > 90) throw new AddressError('Adresse hat ungültige Länge');
  let decoded: ReturnType<ReturnType<typeof Address>['decode']>;
  try {
    decoded = Address(net.btc).decode(trimmed);
  } catch {
    throw new AddressError('Adresse ist ungültig oder gehört zu einem anderen Netzwerk');
  }
  const allowed = new Set(['pkh', 'sh', 'wpkh', 'wsh', 'tr']);
  if (!allowed.has(decoded.type)) throw new AddressError('Adresstyp wird nicht unterstützt');
  return OutScript.encode(decoded);
}

export function scriptToAddress(script: Uint8Array, net: NetworkParams): string {
  return Address(net.btc).encode(OutScript.decode(script));
}
