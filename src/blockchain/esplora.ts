import type { BlockchainProvider, ChainUtxo, Outspend, TxStatus } from './provider.ts';
import { ProviderError } from './provider.ts';
import { parseBlockStatus, parseFeeEstimates, parseHeight, parseOutspend, parseStatus, parseUtxos } from './schemas.ts';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface EsploraOptions {
  baseUrl: string;
  name: string;
  timeoutMs?: number;
  /** Retries for timeouts / 5xx / 429 only. Kept low: every attempt is a Worker subrequest. */
  maxRetries?: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

/** Blockstream Esplora REST client (also compatible with mempool.space's Esplora API). */
export class EsploraProvider implements BlockchainProvider {
  readonly name: string;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Number of HTTP requests made (for subrequest budgeting). */
  requests = 0;

  constructor(o: EsploraOptions) {
    this.name = o.name;
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? 8000;
    this.maxRetries = o.maxRetries ?? 1;
    this.fetchFn = o.fetchFn ?? ((i, init) => fetch(i, init));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(path: string, init?: RequestInit, allow404 = false): Promise<Response | null> {
    let lastErr: ProviderError | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(300 * 2 ** (attempt - 1));
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${path}`, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        lastErr = new ProviderError('timeout', `request failed: ${path}`, this.name);
        continue;
      }
      if (res.ok) return res;
      if (res.status === 404 && allow404) return null;
      if (res.status === 429) {
        lastErr = new ProviderError('rate_limit', 'rate limited', this.name);
        continue;
      }
      if (res.status >= 500) {
        lastErr = new ProviderError('http', `HTTP ${res.status}`, this.name);
        continue;
      }
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new ProviderError(res.status === 400 ? 'rejected' : 'http', `HTTP ${res.status}: ${body}`, this.name);
    }
    throw lastErr ?? new ProviderError('http', 'unknown error', this.name);
  }

  private async json(path: string): Promise<unknown> {
    const res = await this.request(path);
    try {
      return await res!.json();
    } catch {
      throw new ProviderError('invalid_response', 'invalid JSON', this.name);
    }
  }

  async getTipHeight(): Promise<number> {
    const res = await this.request('/blocks/tip/height');
    return parseHeight(await res!.text());
  }

  async getAddressUtxos(address: string): Promise<ChainUtxo[]> {
    return parseUtxos(await this.json(`/address/${encodeURIComponent(address)}/utxo`));
  }

  async getTxStatus(txid: string): Promise<TxStatus | null> {
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new ProviderError('invalid_response', 'bad txid');
    const res = await this.request(`/tx/${txid}/status`, undefined, true);
    if (!res) return null;
    try {
      return parseStatus(await res.json());
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('invalid_response', 'invalid JSON', this.name);
    }
  }

  async getOutspend(txid: string, vout: number): Promise<Outspend> {
    return parseOutspend(await this.json(`/tx/${txid}/outspend/${vout}`));
  }

  async isBlockInBestChain(hash: string): Promise<boolean> {
    return parseBlockStatus(await this.json(`/block/${hash}/status`));
  }

  async getFeeEstimates(): Promise<Record<string, number>> {
    return parseFeeEstimates(await this.json('/fee-estimates'));
  }

  async broadcast(rawTxHex: string): Promise<string> {
    if (!/^[0-9a-f]+$/.test(rawTxHex)) throw new ProviderError('rejected', 'raw tx must be hex');
    // no retry on broadcast POST beyond the generic policy: re-sending the same tx is harmless
    const res = await this.request('/tx', { method: 'POST', body: rawTxHex, headers: { 'content-type': 'text/plain' } });
    const txid = (await res!.text()).trim();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new ProviderError('invalid_response', 'broadcast returned no txid', this.name);
    return txid;
  }
}
