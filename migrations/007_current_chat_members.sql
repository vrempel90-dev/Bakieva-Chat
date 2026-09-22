CREATE TABLE IF NOT EXISTS current_chat_members (
  chat_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'unknown',
  PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS current_chat_members_active_idx
  ON current_chat_members(chat_id, is_active, last_seen_at);
