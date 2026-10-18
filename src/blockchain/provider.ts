/** Abstract blockchain data source. Implementations: Esplora (primary/secondary), test doubles. */

export interface ChainUtxo {
  txid: string;
  vout: number;
  valueSats: bigint;
  confirmed: boolean;
  blockHeight: number | null;
  blockHash: string | null;
}

export interface TxStatus {
  confirmed: boolean;
  blockHeight: number | null;
  blockHash: string | null;
}

export interface Outspend {
  spent: boolean;
  spendingTxid: string | null;
}

/** Total ever received by an address (spends by the owner do not reduce it). */
export interface AddressReceived {
  confirmedSats: bigint;
  mempoolSats: bigint;
}

export interface BlockchainProvider {
  readonly name: string;
  getTipHeight(): Promise<number>;
  getAddressUtxos(address: string): Promise<ChainUtxo[]>;
  getAddressReceived(address: string): Promise<AddressReceived>;
  /** null = transaction unknown to the provider (never seen or dropped). */
  getTxStatus(txid: string): Promise<TxStatus | null>;
  getOutspend(txid: string, vout: number): Promise<Outspend>;
  isBlockInBestChain(hash: string): Promise<boolean>;
  getFeeEstimates(): Promise<Record<string, number>>;
  /** Returns the txid accepted by the node. */
  broadcast(rawTxHex: string): Promise<string>;
}

export type ProviderErrorKind = 'timeout' | 'http' | 'rate_limit' | 'invalid_response' | 'rejected' | 'disagreement';

export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  constructor(kind: ProviderErrorKind, message: string, provider = '') {
    super(message);
    this.kind = kind;
    this.provider = provider;
  }
}
