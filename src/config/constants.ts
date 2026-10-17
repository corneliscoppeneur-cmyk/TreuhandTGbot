/** Fixed protocol and product constants. Configurable values live in env.ts. */

export const CONTRACT_VERSION = 1;

/** Trade ids: 8 chars from an unambiguous alphabet (no 0/O/1/I). */
export const TRADE_ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const TRADE_ID_LENGTH = 8;

export const SATS_PER_BTC = 100_000_000n;
/** 21M BTC upper bound for any amount the bot accepts. */
export const MAX_SATS = 21_000_000n * SATS_PER_BTC;
/** Minimum escrow amount. Keeps payouts well above dust after fees. */
export const MIN_TRADE_SATS = 10_000n;
/** Outputs below this are not created (conservative dust limit for all output types). */
export const DUST_LIMIT_SATS = 546n;

export const INVITE_TTL_SECONDS = 72 * 3600;
export const INVITE_MAX_ATTEMPTS = 5;
export const USER_MAX_FAILED_ATTEMPTS_PER_HOUR = 10;
export const CONVERSATION_TTL_SECONDS = 30 * 60;
export const PSBT_SESSION_TTL_SECONDS = 7 * 24 * 3600;

/** Telegram limits. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
export const TELEGRAM_MAX_START_PAYLOAD = 64;
export const MAX_PSBT_BYTES = 100_000;

/** Free-text limits (data minimisation, abuse protection). */
export const MAX_TITLE_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 1000;
export const MAX_TERMS_CHARS = 2000;
export const MAX_DISPUTE_REASON_CHARS = 1500;

/** BIP-48 multisig account path, script type 2 = native segwit (P2WSH). */
export const BIP48_PURPOSE = 48;
export const BIP48_SCRIPT_TYPE_P2WSH = 2;
/** The escrow address is the first receive address of the descriptor: <xpub>/0/0. */
export const ESCROW_CHAIN = 0;
export const ESCROW_INDEX = 0;
