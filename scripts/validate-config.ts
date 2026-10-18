/**
 * Validates wrangler.jsonc vars plus local secrets (.dev.vars) with the same parser the Worker uses.
 * Usage: npm run validate-config
 */
import { readFileSync, existsSync } from 'node:fs';
import { addressToScript, getNetwork } from '../src/bitcoin/networks.ts';
import { parseConfig } from '../src/config/env.ts';

function stripJsonc(text: string): string {
  return text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
}

const wrangler = JSON.parse(stripJsonc(readFileSync('wrangler.jsonc', 'utf8'))) as { vars: Record<string, string> };
const env: Record<string, string> = { ...wrangler.vars };
if (existsSync('.dev.vars')) {
  for (const line of readFileSync('.dev.vars', 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
}

try {
  const cfg = parseConfig(env);
  addressToScript(cfg.commissionAddress, getNetwork(cfg.network));
  console.log(
    `Config OK: network=${cfg.network}, commission=${cfg.commissionBps} bps, broadcast=${cfg.automaticBroadcast ? 'auto' : 'manual'}`,
  );
} catch (e) {
  console.error(`Config INVALID: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
