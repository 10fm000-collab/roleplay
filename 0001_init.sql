-- characters table
CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar_url TEXT,
  system_prompt TEXT NOT NULL,
  output_protocol_prompt TEXT NOT NULL,
  default_model TEXT NOT NULL,
  story_map_json TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
-- conversations table
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  memory_text TEXT NOT NULL,
  lock_token TEXT,
  lock_expires_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- messages table
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' or 'assistant'
  content TEXT NOT NULL,
  control_json TEXT,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_convo_ts
ON messages(conversation_id, ts);