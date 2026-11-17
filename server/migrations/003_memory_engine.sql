CREATE TABLE memories_v3 (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  character_id TEXT REFERENCES characters(id),
  category TEXT NOT NULL CHECK (category IN (
    'persona', 'fact', 'event', 'relationship',
    'preference', 'habit', 'experience', 'plan', 'shared_event', 'topic', 'open_item', 'background'
  )),
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  explicit INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'suggested', 'rejected', 'superseded', 'expired', 'uncertain')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_confirmed_at TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  supersedes_id TEXT,
  superseded_by TEXT,
  space TEXT NOT NULL DEFAULT 'companion' CHECK (space IN ('companion', 'workspace')),
  CHECK (
    (space = 'companion' AND character_id IS NOT NULL)
    OR (space = 'workspace' AND character_id IS NULL)
  )
);

INSERT INTO memories_v3 (
  id, user_id, character_id, category, content, source, explicit, note, status,
  created_at, updated_at, last_confirmed_at, confidence, supersedes_id, superseded_by, space
)
SELECT
  id, user_id, character_id, category, content, source, explicit, note, status,
  created_at, updated_at,
  CASE WHEN explicit = 1 AND status = 'active' THEN updated_at ELSE NULL END,
  CASE WHEN explicit = 1 THEN 1 ELSE 0.4 END,
  NULL,
  NULL,
  'companion'
FROM memories;

DROP TABLE memories;

ALTER TABLE memories_v3 RENAME TO memories;

CREATE INDEX idx_memories_character ON memories(character_id, user_id);
CREATE INDEX idx_memories_scope ON memories(user_id, space, status);

CREATE TABLE memory_jobs (
  message_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  attempts INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'done', 'failed')),
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memory_applies (
  dedupe_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
