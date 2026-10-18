-- BTC escrow coordinator schema (Cloudflare D1 / SQLite).
-- Amounts are INTEGER satoshis. Timestamps are INTEGER unix seconds.
-- No private keys, seeds or usable access tokens are ever stored.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  telegram_user_id INTEGER PRIMARY KEY,
  username TEXT,
  is_blocked INTEGER NOT NULL DEFAULT 0,
  bot_unreachable INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  creator_id INTEGER NOT NULL REFERENCES users(telegram_user_id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  terms TEXT NOT NULL,
  amount_sats INTEGER NOT NULL CHECK (amount_sats > 0),
  network TEXT NOT NULL CHECK (network IN ('signet', 'mainnet')),
  commission_bps INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 1000),
  refund_commission_bps INTEGER NOT NULL CHECK (refund_commission_bps BETWEEN 0 AND 1000),
  contract_version INTEGER NOT NULL,
  agreement_hash TEXT,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  -- random id of the last state change; follow-up statements in the same batch are guarded by it
  last_op TEXT,
  params_locked_at INTEGER,
  group_chat_id INTEGER,
  review_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_trades_status ON trades(status);
CREATE INDEX idx_trades_creator ON trades(creator_id);

CREATE TABLE participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  telegram_user_id INTEGER NOT NULL REFERENCES users(telegram_user_id),
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'arbiter', 'mediator', 'observer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  agreed_hash TEXT,
  agreed_at INTEGER,
  address_verified_at INTEGER,
  joined_at INTEGER NOT NULL,
  UNIQUE (trade_id, telegram_user_id)
);
CREATE INDEX idx_participants_user ON participants(telegram_user_id);
CREATE INDEX idx_participants_trade ON participants(trade_id);
-- exactly one active buyer / seller / arbiter per trade
CREATE UNIQUE INDEX uq_participants_signer_role ON participants(trade_id, role)
  WHERE status = 'active' AND role IN ('buyer', 'seller', 'arbiter');

CREATE TABLE trade_agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  version INTEGER NOT NULL,
  terms_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (trade_id, version)
);

CREATE TABLE invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'arbiter', 'mediator', 'observer')),
  token_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT,
  bound_user_id INTEGER,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 20),
  uses INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  expires_at INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  redeemed_by INTEGER
);
CREATE INDEX idx_invites_trade ON invites(trade_id);
CREATE INDEX idx_invites_expires ON invites(status, expires_at);

CREATE TABLE access_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id INTEGER NOT NULL,
  invite_id INTEGER,
  success INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_access_attempts_user ON access_attempts(telegram_user_id, created_at);

CREATE TABLE signers_public (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'arbiter')),
  telegram_user_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  derivation_path TEXT NOT NULL,
  xpub TEXT NOT NULL,
  -- <xpub>/0/0, derived once at registration (public key, not secret)
  escrow_pubkey_hex TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (trade_id, role),
  -- an account xpub may be used for one trade only (no key reuse across escrows)
  UNIQUE (xpub)
);
CREATE INDEX idx_signers_trade ON signers_public(trade_id);

CREATE TABLE multisig_configs (
  trade_id TEXT PRIMARY KEY REFERENCES trades(id),
  address TEXT NOT NULL UNIQUE,
  script_pubkey_hex TEXT NOT NULL,
  witness_script_hex TEXT NOT NULL,
  descriptor TEXT NOT NULL,
  signers_json TEXT NOT NULL,
  network TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE funding_outputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  value_sats INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unconfirmed', 'confirmed', 'spent', 'vanished')),
  block_height INTEGER,
  block_hash TEXT,
  spent_txid TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (txid, vout)
);
CREATE INDEX idx_funding_trade ON funding_outputs(trade_id);
CREATE INDEX idx_funding_txid ON funding_outputs(txid);

CREATE TABLE blockchain_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_observations_trade ON blockchain_observations(trade_id, created_at);

CREATE TABLE psbt_sessions (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  kind TEXT NOT NULL CHECK (kind IN ('release', 'refund')),
  status TEXT NOT NULL CHECK (status IN ('open', 'locked', 'finalized', 'broadcast', 'confirmed', 'cancelled', 'failed')),
  base_psbt TEXT NOT NULL,
  unsigned_tx_hex TEXT NOT NULL,
  txid TEXT NOT NULL,
  utxos_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  miner_fee_sats INTEGER NOT NULL,
  fee_rate INTEGER NOT NULL,
  raw_tx_hex TEXT,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  broadcast_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_psbt_trade ON psbt_sessions(trade_id);
CREATE INDEX idx_psbt_txid ON psbt_sessions(txid);
-- at most one live signing session per trade
CREATE UNIQUE INDEX uq_psbt_live ON psbt_sessions(trade_id)
  WHERE status IN ('open', 'locked', 'finalized', 'broadcast');

CREATE TABLE psbt_signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES psbt_sessions(id),
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'arbiter')),
  telegram_user_id INTEGER NOT NULL,
  sigs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, role)
);

CREATE TABLE disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  opened_by INTEGER NOT NULL,
  reason TEXT NOT NULL,
  evidence_links TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'arbitration', 'resolved')),
  decision TEXT CHECK (decision IN ('release', 'refund')),
  decision_note TEXT,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by INTEGER
);
CREATE INDEX idx_disputes_trade ON disputes(trade_id);
CREATE INDEX idx_disputes_status ON disputes(status);
CREATE UNIQUE INDEX uq_disputes_open ON disputes(trade_id) WHERE status <> 'resolved';

CREATE TABLE dispute_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL REFERENCES disputes(id),
  actor_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_dispute_events_dispute ON dispute_events(dispute_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT,
  actor_id INTEGER NOT NULL, -- 0 = system
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_trade ON audit_events(trade_id, created_at);

CREATE TABLE processed_telegram_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at INTEGER NOT NULL
);
CREATE INDEX idx_updates_processed ON processed_telegram_updates(processed_at);

CREATE TABLE scheduled_jobs (
  trade_id TEXT PRIMARY KEY REFERENCES trades(id),
  next_poll_at INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_polled_at INTEGER
);
CREATE INDEX idx_jobs_next_poll ON scheduled_jobs(next_poll_at);

CREATE TABLE system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Short-lived dialog state for multi-step private flows (expires automatically).
CREATE TABLE conversation_state (
  telegram_user_id INTEGER PRIMARY KEY,
  flow TEXT NOT NULL,
  step TEXT NOT NULL,
  data_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
