import { HDKey } from '@scure/bip32';
import { p2wpkh, TEST_NETWORK } from '@scure/btc-signer';
const hd = HDKey.fromExtendedKey('tpubDCJkE1kXVkWc29KD1SqsUx7yzPgTpWQkQ5jtvgRgFiTbG9oNj8D9LE4ZHFAhFUny4ZSYnzqGdUTZThbHGDgfTqJJTt25knDWvnc12jgYowD', { public: 0x043587cf, private: 0x04358394 });
let conf = 0, mem = 0;
for (let i = 0; i < 20; i++) {
  const a = p2wpkh(hd.deriveChild(0).deriveChild(i).publicKey!, TEST_NETWORK).address!;
  const r = await (await fetch(`https://mempool.space/signet/api/address/${a}`)).json() as any;
  const c = r.chain_stats.funded_txo_sum - r.chain_stats.spent_txo_sum, m = r.mempool_stats.funded_txo_sum - r.mempool_stats.spent_txo_sum;
  if (c || m) console.log(i, a, 'bestätigt', c, '| unterwegs', m);
  conf += c; mem += m;
}
console.log('SUMME bestätigt', conf, 'sat | unterwegs', mem, 'sat | gebraucht ca. 10700 sat');
