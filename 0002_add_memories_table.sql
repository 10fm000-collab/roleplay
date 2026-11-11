-- Long-term memory metadata (source-of-truth)
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  world_id TEXT NOT NULL DEFAULT 'default',

  memory_type TEXT NOT NULL,     -- fact/preference/episode/promise/etc
  content TEXT NOT NULL,         -- canonical memory text
  importance REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active', -- active/superseded/deleted

  participants_json TEXT,        -- JSON array string
  location TEXT,
  emotion TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL DEFAULT 0,
  access_count INTEGER NOT NULL DEFAULT 0,

  qdrant_point_id TEXT,
  embedding_provider TEXT,
  embedding_model TEXT
);

CREATE INDEX IF NOT EXISTS idx_mem_owner
  ON memories(user_id, world_id, character_id, conversation_id);

CREATE INDEX IF NOT EXISTS idx_mem_type_status
  ON memories(user_id, memory_type, status);

CREATE INDEX IF NOT EXISTS idx_mem_updated
  ON memories(updated_at);