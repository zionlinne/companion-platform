-- pragma-fk-off
-- Rebuild users so Better Auth can omit the legacy password column.
-- Existing password hashes are copied into auth_account for the scrypt$ bridge.

CREATE TABLE users_next (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  deleted_at TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  banned INTEGER,
  banReason TEXT,
  banExpires TEXT
);

INSERT INTO users_next (
  id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at, email_verified
)
SELECT id, email, password_hash, display_name, role, created_at, updated_at, last_seen_at, deleted_at, 0
FROM users;

DROP TABLE users;
ALTER TABLE users_next RENAME TO users;

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  impersonatedBy TEXT
);

CREATE TABLE auth_account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE auth_verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX auth_session_userId_idx ON auth_session (userId);
CREATE INDEX auth_account_userId_idx ON auth_account (userId);
CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier);

INSERT INTO auth_account (id, accountId, providerId, userId, password, createdAt, updatedAt)
SELECT id || '-credential', id, 'credential', id, password_hash, created_at, updated_at
FROM users
WHERE password_hash IS NOT NULL AND password_hash != '';

CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  avatar_text TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  level TEXT NOT NULL DEFAULT 'member',
  entitlements TEXT NOT NULL DEFAULT '{}',
  registered_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_fen INTEGER NOT NULL DEFAULT 0 CHECK (available_fen >= 0),
  frozen_fen INTEGER NOT NULL DEFAULT 0 CHECK (frozen_fen >= 0),
  recharge_fen INTEGER NOT NULL DEFAULT 0 CHECK (recharge_fen >= 0),
  spent_fen INTEGER NOT NULL DEFAULT 0 CHECK (spent_fen >= 0),
  refund_fen INTEGER NOT NULL DEFAULT 0 CHECK (refund_fen >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_fen INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  unit TEXT NOT NULL DEFAULT 'fen',
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  entry TEXT NOT NULL,
  request_id TEXT NOT NULL,
  related_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (request_id, entry)
);

CREATE INDEX wallet_transactions_user_idx ON wallet_transactions (user_id, created_at);

CREATE TABLE recharge_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
  provider TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE model_usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  category TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  provider_cost_fen INTEGER,
  provider_cost_status TEXT NOT NULL,
  provider_currency TEXT,
  fx_source TEXT,
  fx_quoted_at TEXT,
  user_charge_fen INTEGER,
  margin_fen INTEGER,
  margin_bps INTEGER,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE user_model_permissions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, model)
);

CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  reason TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_settings (key, value) VALUES ('gateway_paused', '0');
INSERT INTO app_settings (key, value) VALUES ('margin_bps', '3000');

ALTER TABLE quotas ADD COLUMN daily_budget_fen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotas ADD COLUMN max_concurrent INTEGER NOT NULL DEFAULT 0;

INSERT INTO user_profiles (user_id, username, avatar_text, status, level, entitlements, registered_at, last_login_at)
SELECT id, NULL, NULL, 'active', CASE role WHEN 'admin' THEN 'admin' ELSE 'member' END, '{}', created_at, last_seen_at
FROM users;

INSERT INTO wallets (user_id, available_fen, frozen_fen, recharge_fen, spent_fen, refund_fen, created_at)
SELECT id, 0, 0, 0, 0, 0, created_at FROM users;

CREATE VIEW admin_users AS
SELECT id AS user_id, email, role, banned
FROM users
WHERE role = 'admin' AND deleted_at IS NULL;
