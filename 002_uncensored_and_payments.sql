-- Uncensored servers (admin managed)
CREATE TABLE IF NOT EXISTS uncensored_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model_name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Conversation mode (default | uncensored)
ALTER TABLE conversations ADD COLUMN model_mode TEXT NOT NULL DEFAULT 'default';

-- Payment orders (Razorpay coins)
CREATE TABLE IF NOT EXISTS payment_orders (
  order_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  rupees INTEGER NOT NULL,
  coins INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'created', -- created|paid
  payment_id TEXT,
  signature TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user
ON payment_orders(user_id, created_at DESC);