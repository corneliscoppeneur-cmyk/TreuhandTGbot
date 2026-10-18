import type { BlockchainProvider, ChainUtxo, Outspend, TxStatus } from './provider.ts';
import { ProviderError } from './provider.ts';

function utxoKey(u: ChainUtxo): string {
  return `${u.txid}:${u.vout}:${u.valueSats}:${u.confirmed ? u.blockHash : 'mempool'}`;
}

/**
 * Cross-checking provider. Security-relevant reads (UTXOs, tx confirmation, outspends) are
 * confirmed by a second, independent provider when configured. Disagreement is never ignored:
 * it raises ProviderError('disagreement') and the caller moves the trade to a safe state.
 * Broadcast is sent to both providers; success on either counts.
 */
export class CrossCheckedProvider implements BlockchainProvider {
  readonly name: string;
  private readonly primary: BlockchainProvider;
  private readonly secondary: BlockchainProvider | null;
  constructor(primary: BlockchainProvider, secondary: BlockchainProvider | null) {
    this.primary = primary;
    this.secondary = secondary;
    this.name = secondary ? `${primary.name}+${secondary.name}` : primary.name;
  }

  get hasSecondary(): boolean {
    return this.secondary !== null;
  }

  getTipHeight(): Promise<number> {
    return this.primary.getTipHeight();
  }

  async getAddressUtxos(address: string): Promise<ChainUtxo[]> {
    const a = await this.primary.getAddressUtxos(address);
    if (!this.secondary) return a;
    const b = await this.secondary.getAddressUtxos(address);
    // Compare confirmed sets strictly; mempool views may legitimately differ for a short time.
    const conf = (l: ChainUtxo[]) =>
      l
        .filter((u) => u.confirmed)
        .map(utxoKey)
        .sort()
        .join('|');
    if (conf(a) !== conf(b)) throw new ProviderError('disagreement', 'providers disagree on confirmed UTXOs');
    return a;
  }

  async getTxStatus(txid: string): Promise<TxStatus | null> {
    const a = await this.primary.getTxStatus(txid);
    if (!this.secondary || !a?.confirmed) return a;
    const b = await this.secondary.getTxStatus(txid);
    if (!b?.confirmed || b.blockHash !== a.blockHash) throw new ProviderError('disagreement', 'providers disagree on tx status');
    return a;
  }

  async getOutspend(txid: string, vout: number): Promise<Outspend> {
    const a = await this.primary.getOutspend(txid, vout);
    if (!this.secondary) return a;
    const b = await this.secondary.getOutspend(txid, vout);
    if (a.spent !== b.spent || a.spendingTxid !== b.spendingTxid) {
      throw new ProviderError('disagreement', 'providers disagree on outspend');
    }
    return a;
  }

  isBlockInBestChain(hash: string): Promise<boolean> {
    return this.primary.isBlockInBestChain(hash);
  }

  getFeeEstimates(): Promise<Record<string, number>> {
    return this.primary.getFeeEstimates();
  }

  async broadcast(rawTxHex: string): Promise<string> {
    const results = await Promise.allSettled([
      this.primary.broadcast(rawTxHex),
      ...(this.secondary ? [this.secondary.broadcast(rawTxHex)] : []),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value);
    if (ok.length === 0) {
      const first = results[0] as PromiseRejectedResult;
      throw first.reason instanceof ProviderError ? first.reason : new ProviderError('http', 'broadcast failed');
    }
    if (new Set(ok).size > 1) throw new ProviderError('disagreement', 'providers returned different txids');
    return ok[0]!;
  }
}
