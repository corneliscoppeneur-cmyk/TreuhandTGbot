-- Operator mode and upfront fee.
-- 1) Upfront fee: each trade gets its own fee address (derived from the operator's watch-only fee xpub).
ALTER TABLE trades ADD COLUMN fee_sats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN fee_index INTEGER;
ALTER TABLE trades ADD COLUMN fee_address TEXT;
ALTER TABLE trades ADD COLUMN fee_paid_at INTEGER;
CREATE UNIQUE INDEX uq_trades_fee_index ON trades(fee_index) WHERE fee_index IS NOT NULL;

-- 2) The operator (automatic arbiter) uses the same arbiter key in every trade.
--    Recreate signers_public: xpub uniqueness now applies to participant keys only.
CREATE TABLE signers_public_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller', 'arbiter')),
  telegram_user_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  derivation_path TEXT NOT NULL,
  xpub TEXT NOT NULL,
  escrow_pubkey_hex TEXT NOT NULL,
  is_operator INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (trade_id, role)
);
INSERT INTO signers_public_new (id, trade_id, role, telegram_user_id, fingerprint, derivation_path, xpub, escrow_pubkey_hex, is_operator, created_at)
  SELECT id, trade_id, role, telegram_user_id, fingerprint, derivation_path, xpub, escrow_pubkey_hex, 0, created_at FROM signers_public;
DROP TABLE signers_public;
ALTER TABLE signers_public_new RENAME TO signers_public;
CREATE INDEX idx_signers_trade ON signers_public(trade_id);
CREATE UNIQUE INDEX uq_signers_xpub ON signers_public(xpub) WHERE is_operator = 0;
