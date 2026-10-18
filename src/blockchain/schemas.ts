/** Strict response validation for Esplora. Anything unexpected is treated as an invalid response. */
import type { ChainUtxo, Outspend, TxStatus } from './provider.ts';
import { ProviderError } from './provider.ts';

const HEX64 = /^[0-9a-f]{64}$/;

function bad(what: string): never {
  throw new ProviderError('invalid_response', `invalid ${what}`);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(what);
  return v as Record<string, unknown>;
}

function txid(v: unknown, what: string): string {
  if (typeof v !== 'string' || !HEX64.test(v)) bad(what);
  return v;
}

function nonNegInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) bad(what);
  return v;
}

export function parseStatus(v: unknown): TxStatus {
  const s = obj(v, 'status');
  if (typeof s.confirmed !== 'boolean') bad('status.confirmed');
  if (!s.confirmed) return { confirmed: false, blockHeight: null, blockHash: null };
  return {
    confirmed: true,
    blockHeight: nonNegInt(s.block_height, 'status.block_height'),
    blockHash: txid(s.block_hash, 'status.block_hash'),
  };
}

export function parseUtxos(v: unknown): ChainUtxo[] {
  if (!Array.isArray(v)) bad('utxo list');
  if (v.length > 500) bad('utxo list too long');
  return v.map((item) => {
    const u = obj(item, 'utxo');
    const st = parseStatus(u.status);
    const value = nonNegInt(u.value, 'utxo.value');
    return {
      txid: txid(u.txid, 'utxo.txid'),
      vout: nonNegInt(u.vout, 'utxo.vout'),
      valueSats: BigInt(value),
      confirmed: st.confirmed,
      blockHeight: st.blockHeight,
      blockHash: st.blockHash,
    };
  });
}

export function parseOutspend(v: unknown): Outspend {
  const o = obj(v, 'outspend');
  if (typeof o.spent !== 'boolean') bad('outspend.spent');
  return { spent: o.spent, spendingTxid: o.spent ? txid(o.txid, 'outspend.txid') : null };
}

export function parseHeight(text: string): number {
  const t = text.trim();
  if (!/^\d{1,9}$/.test(t)) bad('height');
  return Number(t);
}

export function parseFeeEstimates(v: unknown): Record<string, number> {
  const o = obj(v, 'fee estimates');
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(o)) {
    if (/^\d{1,4}$/.test(k) && typeof val === 'number' && Number.isFinite(val) && val > 0 && val < 100_000) out[k] = val;
  }
  return out;
}

export function parseBlockStatus(v: unknown): boolean {
  const o = obj(v, 'block status');
  if (typeof o.in_best_chain !== 'boolean') bad('block.in_best_chain');
  return o.in_best_chain;
}
