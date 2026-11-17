PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  deleted_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE invitation_redemptions (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES invitations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (invitation_id, user_id)
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  avatar_text TEXT NOT NULL DEFAULT '',
  identity TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  traits TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  habits TEXT NOT NULL DEFAULT '',
  relationship TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL,
  initiative_enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  category TEXT NOT NULL CHECK (category IN ('persona', 'fact', 'event', 'relationship')),
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  explicit INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('active', 'suggested', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  space TEXT NOT NULL CHECK (space IN ('workspace', 'companion')),
  character_id TEXT,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  active_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  reasoning TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'streaming', 'error', 'aborted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  space TEXT NOT NULL CHECK (space IN ('workspace', 'companion')),
  conversation_id TEXT,
  message_id TEXT,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  storage_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'done')),
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE timeline_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  project_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE timeline_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL REFERENCES timeline_events(id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  allow_title INTEGER NOT NULL,
  allow_summary INTEGER NOT NULL,
  allow_occurred_at INTEGER NOT NULL,
  allow_due_at INTEGER NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE access_audits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  actor TEXT NOT NULL,
  grant_id TEXT,
  event_id TEXT,
  character_id TEXT,
  fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE initiative_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  enabled INTEGER NOT NULL DEFAULT 0,
  quiet_start_minute INTEGER,
  quiet_end_minute INTEGER,
  daily_limit INTEGER NOT NULL DEFAULT 3,
  max_model_calls_per_tick INTEGER NOT NULL DEFAULT 1,
  trigger_authorized_timeline INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE initiative_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  trigger_type TEXT NOT NULL,
  event_id TEXT,
  character_id TEXT,
  status TEXT NOT NULL,
  conversation_id TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  conversation_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE usage_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  conversation_id TEXT,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_micro_usd INTEGER,
  cost_status TEXT NOT NULL CHECK (cost_status IN ('calculated', 'unknown', 'fixture')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE quotas (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  daily_request_limit INTEGER NOT NULL,
  daily_token_limit INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memory_previews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  items_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_characters_user ON characters(user_id);
CREATE INDEX idx_memories_character ON memories(character_id, user_id);
CREATE INDEX idx_conversations_user_space ON conversations(user_id, space);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_attachments_user ON attachments(user_id);
CREATE INDEX idx_timeline_user ON timeline_events(user_id, occurred_at);
CREATE INDEX idx_usage_user_time ON usage_ledger(user_id, created_at);
