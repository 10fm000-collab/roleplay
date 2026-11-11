-- migrations/003_ratelimit_and_settings.sql

CREATE TABLE IF NOT EXISTS rate_limits (
  rl_key      TEXT PRIMARY KEY,
  hits        INTEGER NOT NULL DEFAULT 1,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rl_expires
  ON rate_limits(expires_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key     TEXT PRIMARY KEY,
  val_int INTEGER,
  val_txt TEXT
);