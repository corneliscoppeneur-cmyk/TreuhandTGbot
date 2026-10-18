-- Second idempotency layer: Telegram may deliver the same user action as several updates
-- with different update_ids. Messages are deduplicated by chat + message id (forever),
-- button clicks by user + callback data within a short window (double-click protection).
CREATE TABLE recent_actions (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX idx_recent_actions_at ON recent_actions(at);
