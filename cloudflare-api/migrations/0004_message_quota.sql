PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS message_usage (
  customer_id TEXT PRIMARY KEY NOT NULL,
  period_key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
