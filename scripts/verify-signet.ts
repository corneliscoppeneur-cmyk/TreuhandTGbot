/**
 * Read-only Signet compatibility check against the real public Esplora APIs.
 * Builds a 2-of-3 escrow from TEST-ONLY keys, queries both providers and compares results.
 * Never broadcasts. Usage: npm run verify-signet
 */
import { HDKey } from '@scure/bip32';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { parseSignerKey } from '../src/bitcoin/descriptor.ts';
import { buildMultisig } from '../src/bitcoin/multisig.ts';
import { SIGNET } from '../src/bitcoin/networks.ts';
import { pickFeeRate } from '../src/bitcoin/fee-estimator.ts';
import { EsploraProvider } from '../src/blockchain/esplora.ts';
import { CrossCheckedProvider } from '../src/blockchain/fallback.ts';

const PRIMARY = process.env.ESPLORA_PRIMARY_URL ?? 'https://mempool.space/signet/api';
const SECONDARY = process.env.ESPLORA_SECONDARY_URL ?? 'https://blockstream.info/signet/api';

function testKey(name: string): string {
  const root = HDKey.fromMasterSeed(sha256(utf8ToBytes(`TEST-ONLY-NOT-A-REAL-WALLET:${name}`)), {
    public: 0x043587cf,
    private: 0x04358394,
  });
  const acc = root.derive("m/48'/1'/0'/2'");
  return `[${root.fingerprint.toString(16).padStart(8, '0')}/48h/1h/0h/2h]${acc.publicExtendedKey}`;
}

async function main(): Promise<void> {
  const results: [string, boolean, string][] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      results.push([name, true, await fn()]);
    } catch (e) {
      results.push([name, false, e instanceof Error ? e.message : String(e)]);
    }
  };

  const cfg = buildMultisig(
    (['buyer', 'seller', 'arbiter'] as const).map((role) => ({ role, ...parseSignerKey(testKey(role), SIGNET) })),
    SIGNET,
  );
  const a = new EsploraProvider({ baseUrl: PRIMARY, name: 'primary' });
  const b = new EsploraProvider({ baseUrl: SECONDARY, name: 'secondary' });
  const both = new CrossCheckedProvider(a, b);

  await check('multisig address (signet)', async () => cfg.address);
  await check('descriptor', async () => cfg.descriptor);
  await check('tip height primary/secondary', async () => {
    const [x, y] = await Promise.all([a.getTipHeight(), b.getTipHeight()]);
    if (Math.abs(x - y) > 3) throw new Error(`tips differ: ${x} vs ${y}`);
    return `${x} / ${y}`;
  });
  await check('fee estimates', async () => `pick(6) = ${pickFeeRate(await a.getFeeEstimates(), 6)} sat/vB`);
  await check('address utxos (cross-checked)', async () => `${(await both.getAddressUtxos(cfg.address)).length} utxo(s)`);
  await check('unknown tx status', async () => JSON.stringify(await a.getTxStatus('00'.repeat(32))));

  for (const [name, ok, detail] of results) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${detail}`);
  if (results.some((r) => !r[1])) process.exit(1);
}

await main();
