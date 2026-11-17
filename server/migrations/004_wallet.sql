CREATE TABLE wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  available_fen INTEGER NOT NULL DEFAULT 0 CHECK (available_fen >= 0),
  frozen_fen INTEGER NOT NULL DEFAULT 0 CHECK (frozen_fen >= 0),
  recharge_fen INTEGER NOT NULL DEFAULT 0 CHECK (recharge_fen >= 0),
  spent_fen INTEGER NOT NULL DEFAULT 0 CHECK (spent_fen >= 0),
  refund_fen INTEGER NOT NULL DEFAULT 0 CHECK (refund_fen >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO wallets (user_id, available_fen, frozen_fen, recharge_fen, spent_fen, refund_fen, updated_at)
SELECT id, 0, 0, 0, 0, 0, created_at FROM users
WHERE NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = users.id);

CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  entry TEXT NOT NULL,
  amount_fen INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (request_id, entry)
);

CREATE TABLE recharge_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'paid', 'rejected', 'cancelled')),
  provider TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  user_reference TEXT,
  payment_reference TEXT,
  review_note TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  paid_at TEXT
);

CREATE UNIQUE INDEX recharge_payment_reference_unique
  ON recharge_orders (payment_reference)
  WHERE payment_reference IS NOT NULL;

CREATE INDEX recharge_orders_user_idx ON recharge_orders (user_id, created_at);

CREATE TABLE payment_qrcodes (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  mime TEXT NOT NULL,
  image_base64 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_fen INTEGER,
  charge_fen INTEGER,
  margin_bps INTEGER,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE admin_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
