CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  coins INTEGER NOT NULL DEFAULT 0,

  plan TEXT NOT NULL DEFAULT 'free',          -- free|plus|pro
  plan_expires_at INTEGER NOT NULL DEFAULT 0, -- unix seconds

  first_bonus_given INTEGER NOT NULL DEFAULT 0,
  last_daily_claim_key TEXT NOT NULL DEFAULT '',

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  meta_json TEXT,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user_ts
ON wallet_ledger(user_id, ts DESC);