/**
 * Environment parsing and validation. Every value is validated; invalid
 * configuration throws ConfigError and the Worker refuses to process requests.
 */

export interface Env {
  DB: D1Database;
  // Secrets (wrangler secret put ...)
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  INVITE_HMAC_SECRET: string;
  // Vars
  TELEGRAM_BOT_USERNAME: string;
  BITCOIN_NETWORK: string;
  ALLOW_MAINNET: string;
  MAINNET_RELEASE_CONFIRMATION?: string;
  SUPPORT_BOT_URL: string;
  CRYPTGEON_URL: string;
  DEFAULT_COMMISSION_BPS: string;
  REFUND_COMMISSION_BPS: string;
  COMMISSION_ADDRESS: string;
  MIN_CONFIRMATIONS_SIGNET: string;
  MIN_CONFIRMATIONS_MAINNET: string;
  BLOCKCHAIN_PROVIDER: string;
  ESPLORA_PRIMARY_URL: string;
  ESPLORA_SECONDARY_URL?: string;
  MAX_FEE_RATE_SAT_VB: string;
  MAX_FEE_PERCENT: string;
  POLL_MAX_TRADES_PER_RUN: string;
  ENABLE_AUTOMATIC_BROADCAST: string;
  ENABLE_CUSTODIAL_FEATURES: string;
  ADMIN_TELEGRAM_IDS?: string;
  /** Operator mode: the operator is automatically the arbiter (third key) of every trade. */
  OPERATOR_TELEGRAM_ID?: string;
  /** Operator arbiter key expression [fp/48h/coin h/acct h/2h]tpub… (public, watch-only). */
  OPERATOR_ARBITER_KEY?: string;
  /** Operator fee wallet: BIP-84 account tpub/vpub (public). One fresh fee address per trade. */
  COMMISSION_XPUB?: string;
  DATA_RETENTION_DAYS: string;
}

export type BitcoinNetworkName = 'signet' | 'mainnet';

export interface AppConfig {
  botToken: string;
  webhookSecret: string;
  inviteHmacSecret: string;
  botUsername: string;
  network: BitcoinNetworkName;
  supportUrl: string;
  cryptgeonUrl: string;
  commissionBps: number;
  refundCommissionBps: number;
  commissionAddress: string;
  minConfirmations: number;
  esploraPrimaryUrl: string;
  esploraSecondaryUrl: string | null;
  maxFeeRateSatVb: number;
  maxFeePercent: number;
  pollMaxTradesPerRun: number;
  automaticBroadcast: boolean;
  adminIds: ReadonlySet<number>;
  /** Telegram id of the operator acting as automatic arbiter, or null (arbiter is invited). */
  operatorId: number | null;
  operatorArbiterKey: string | null;
  /** Fee wallet xpub: if set, the fee is paid upfront at deposit to a per-trade address (cannot be bypassed). */
  commissionXpub: string | null;
  dataRetentionDays: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Exact string the operator must set in MAINNET_RELEASE_CONFIRMATION (see docs/MAINNET-CHECKLIST.md). */
export const MAINNET_RELEASE_PHRASE = 'I-HAVE-COMPLETED-THE-MAINNET-CHECKLIST-AND-AUDIT';

function req(env: Record<string, unknown>, key: string): string {
  const v = env[key];
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`Missing config: ${key}`);
  return v.trim();
}

function opt(env: Record<string, unknown>, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function int(env: Record<string, unknown>, key: string, min: number, max: number): number {
  const raw = req(env, key);
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} must be a non-negative integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${key} must be between ${min} and ${max}`);
  return n;
}

function bool(env: Record<string, unknown>, key: string): boolean {
  const raw = req(env, key).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${key} must be "true" or "false"`);
}

function httpsUrl(env: Record<string, unknown>, key: string, value: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError(`${key} is not a valid URL`);
  }
  if (u.protocol !== 'https:') throw new ConfigError(`${key} must use https`);
  return value.replace(/\/+$/, '');
}

export function parseConfig(env: Record<string, unknown>): AppConfig {
  if (bool(env, 'ENABLE_CUSTODIAL_FEATURES')) {
    throw new ConfigError('ENABLE_CUSTODIAL_FEATURES must be false: custodial mode does not exist');
  }

  const netRaw = req(env, 'BITCOIN_NETWORK').toLowerCase();
  if (netRaw !== 'signet' && netRaw !== 'mainnet') {
    throw new ConfigError('BITCOIN_NETWORK must be "signet" or "mainnet"');
  }
  const network: BitcoinNetworkName = netRaw;
  if (network === 'mainnet') {
    // Two independent switches are required; changing BITCOIN_NETWORK alone never enables mainnet.
    const allow = bool(env, 'ALLOW_MAINNET');
    const phrase = opt(env, 'MAINNET_RELEASE_CONFIRMATION');
    if (!allow || phrase !== MAINNET_RELEASE_PHRASE) {
      throw new ConfigError('Mainnet is locked. See docs/MAINNET-CHECKLIST.md');
    }
  }

  const botToken = req(env, 'TELEGRAM_BOT_TOKEN');
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) throw new ConfigError('TELEGRAM_BOT_TOKEN has invalid format');
  const webhookSecret = req(env, 'TELEGRAM_WEBHOOK_SECRET');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
    throw new ConfigError('TELEGRAM_WEBHOOK_SECRET must be 32-256 chars of [A-Za-z0-9_-]');
  }
  const inviteHmacSecret = req(env, 'INVITE_HMAC_SECRET');
  if (inviteHmacSecret.length < 32) throw new ConfigError('INVITE_HMAC_SECRET must be at least 32 chars');

  const botUsername = req(env, 'TELEGRAM_BOT_USERNAME').replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{5,32}$/.test(botUsername)) throw new ConfigError('TELEGRAM_BOT_USERNAME invalid');

  const provider = req(env, 'BLOCKCHAIN_PROVIDER');
  if (provider !== 'esplora') throw new ConfigError('BLOCKCHAIN_PROVIDER must be "esplora"');

  const secondary = opt(env, 'ESPLORA_SECONDARY_URL');
  const adminIds = new Set<number>();
  for (const part of (opt(env, 'ADMIN_TELEGRAM_IDS') ?? '').split(',')) {
    const p = part.trim();
    if (p === '') continue;
    if (!/^\d{1,15}$/.test(p)) throw new ConfigError('ADMIN_TELEGRAM_IDS must be comma-separated numeric ids');
    adminIds.add(Number(p));
  }

  const commissionAddress = req(env, 'COMMISSION_ADDRESS');

  const operatorRaw = opt(env, 'OPERATOR_TELEGRAM_ID');
  const operatorArbiterKey = opt(env, 'OPERATOR_ARBITER_KEY');
  if ((operatorRaw === null) !== (operatorArbiterKey === null)) {
    throw new ConfigError('OPERATOR_TELEGRAM_ID and OPERATOR_ARBITER_KEY must be set together');
  }
  if (operatorRaw !== null && !/^\d{1,15}$/.test(operatorRaw)) throw new ConfigError('OPERATOR_TELEGRAM_ID must be numeric');
  const operatorId = operatorRaw === null ? null : Number(operatorRaw);
  // the operator always receives admin notices
  if (operatorId !== null) adminIds.add(operatorId);

  return {
    botToken,
    webhookSecret,
    inviteHmacSecret,
    botUsername,
    network,
    supportUrl: httpsUrl(env, 'SUPPORT_BOT_URL', req(env, 'SUPPORT_BOT_URL')),
    cryptgeonUrl: httpsUrl(env, 'CRYPTGEON_URL', req(env, 'CRYPTGEON_URL')),
    commissionBps: int(env, 'DEFAULT_COMMISSION_BPS', 0, 1000),
    refundCommissionBps: int(env, 'REFUND_COMMISSION_BPS', 0, 1000),
    commissionAddress,
    minConfirmations: network === 'signet' ? int(env, 'MIN_CONFIRMATIONS_SIGNET', 1, 100) : int(env, 'MIN_CONFIRMATIONS_MAINNET', 3, 100),
    esploraPrimaryUrl: httpsUrl(env, 'ESPLORA_PRIMARY_URL', req(env, 'ESPLORA_PRIMARY_URL')),
    esploraSecondaryUrl: secondary ? httpsUrl(env, 'ESPLORA_SECONDARY_URL', secondary) : null,
    maxFeeRateSatVb: int(env, 'MAX_FEE_RATE_SAT_VB', 1, 2000),
    maxFeePercent: int(env, 'MAX_FEE_PERCENT', 1, 50),
    pollMaxTradesPerRun: int(env, 'POLL_MAX_TRADES_PER_RUN', 1, 20),
    automaticBroadcast: bool(env, 'ENABLE_AUTOMATIC_BROADCAST'),
    adminIds,
    operatorId,
    operatorArbiterKey,
    commissionXpub: opt(env, 'COMMISSION_XPUB'),
    dataRetentionDays: int(env, 'DATA_RETENTION_DAYS', 30, 3650),
  };
}
