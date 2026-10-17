/**
 * Log redaction. Removes anything that could be a secret or payment detail before logging/audit.
 * Defensive: the code never logs private keys, but users may paste them by mistake.
 */

const PATTERNS: [RegExp, string][] = [
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[bot-token]'],
  [/\b[tx]prv[1-9A-HJ-NP-Za-km-z]{100,}\b/g, '[xprv]'],
  [/\b[1-9A-HJ-NP-Za-km-z]{100,120}\b/g, '[extended-key]'],
  [/\b(?:bc|tb|bcrt)1[02-9ac-hj-np-z]{11,87}\b/gi, '[address]'],
  [/\b[123mn2][1-9A-HJ-NP-Za-km-z]{25,34}\b/g, '[address]'],
  [/\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, '[wif]'],
  [/\bcHNidP8[A-Za-z0-9+/=]{20,}/g, '[psbt]'],
  [/\b[0-9a-f]{64}\b/gi, '[hex64]'],
  [/start=[A-Za-z0-9_-]{10,}/g, 'start=[token]'],
];

/** Heuristic: looks like a BIP-39 mnemonic (12+ lowercase words only). */
export function looksLikeMnemonic(text: string): boolean {
  const words = text.trim().toLowerCase().split(/\s+/);
  return words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]{3,8}$/.test(w));
}

/** Looks like a private key / xprv / WIF anywhere in the text. */
export function looksLikePrivateKey(text: string): boolean {
  return /\b[tx]prv[1-9A-HJ-NP-Za-km-z]{100,}/.test(text) || /\b[yzYZuvUV]prv/.test(text) || /\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/.test(text);
}

export function redact(input: unknown): string {
  let s: string;
  if (input instanceof Error) s = `${input.name}: ${input.message}`;
  else if (typeof input === 'string') s = input;
  else {
    try {
      s = JSON.stringify(input, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch {
      s = String(input);
    }
  }
  if (looksLikeMnemonic(s)) return '[mnemonic-redacted]';
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}

export function logError(scope: string, err: unknown): void {
  console.error(`[${scope}] ${redact(err)}`);
}

export function logInfo(scope: string, msg: string): void {
  console.log(`[${scope}] ${redact(msg)}`);
}
