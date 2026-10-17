import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { base64urlnopad, hex } from '@scure/base';
import { TRADE_ID_ALPHABET, TRADE_ID_LENGTH } from '../config/constants.ts';

/** Cryptographically secure random bytes (Web Crypto; available in Workers and Node). */
export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Uniform random string from an alphabet (rejection sampling, no modulo bias). */
export function randomFromAlphabet(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export function newTradeId(): string {
  return randomFromAlphabet(TRADE_ID_ALPHABET, TRADE_ID_LENGTH);
}

export function newSessionId(): string {
  return base64urlnopad.encode(randomBytes(12));
}

/** Opaque invite token for Telegram deep links: 32 random bytes, base64url (43 chars). */
export function newInviteToken(): string {
  return base64urlnopad.encode(randomBytes(32));
}

/** One-time access code shown to the inviter, passed to the invitee out-of-band. */
export function newAccessCode(): string {
  return randomFromAlphabet(TRADE_ID_ALPHABET, 8);
}

/** Keyed hash for storing tokens/codes; only this digest is stored in D1, never the usable value. */
export function hmacHex(secret: string, purpose: string, value: string): string {
  return hex.encode(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`${purpose}:${value}`)));
}

export function sha256Hex(value: string): string {
  return hex.encode(sha256(utf8ToBytes(value)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const x = utf8ToBytes(a);
  const y = utf8ToBytes(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function isInviteTokenFormat(s: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(s);
}
