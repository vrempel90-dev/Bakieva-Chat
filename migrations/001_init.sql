CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  marketing_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consents (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by BIGINT,
  approved_at TIMESTAMPTZ,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_payment_per_user
  ON payments(user_id) WHERE status='pending';

CREATE TABLE IF NOT EXISTS subscriptions (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active','expired','revoked')),
  active_until TIMESTAMPTZ NOT NULL,
  last_reminder_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- News publication log: each destination has a separately recorded Telegram result.
CREATE TABLE IF NOT EXISTS news_publications (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  source_chat_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_chat_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS news_deliveries (
  publication_id BIGINT NOT NULL REFERENCES news_publications(id) ON DELETE CASCADE,
  target_chat_id BIGINT NOT NULL,
  target_title TEXT NOT NULL,
  target_username TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  sent_message_id BIGINT,
  error_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(publication_id, target_chat_id)
);


-- The roster includes existing members imported later, and joins/leaves observed live.
-- Unknown historical join dates must remain NULL, never be inferred from first_seen_at.
CREATE TABLE IF NOT EXISTS chat_memberships (
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  is_member BOOLEAN NOT NULL DEFAULT TRUE,
  joined_at TIMESTAMPTZ,
  join_source TEXT NOT NULL DEFAULT 'unknown',
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_memberships_joined_at
  ON chat_memberships (chat_id, joined_at DESC);

CREATE TABLE IF NOT EXISTS membership_events (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('joined','left')),
  event_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chat_id, user_id, event_type, event_at)
);
CREATE INDEX IF NOT EXISTS idx_membership_events_recent
  ON membership_events(chat_id, event_at DESC);
