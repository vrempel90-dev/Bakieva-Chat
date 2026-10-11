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

-- Existing paid chat roster records were observed before this feature, but did
-- not record authentic join dates. Keep them NULL, and preserve first_seen_at.
INSERT INTO chat_memberships(
  chat_id,user_id,username,first_name,last_name,is_member,
  joined_at,join_source,first_seen_at,last_seen_at,left_at
)
SELECT c.chat_id,c.user_id,u.username,u.first_name,u.last_name,c.is_active,
       NULL,'unknown',c.first_seen_at,c.last_seen_at,c.left_at
FROM current_chat_members c
LEFT JOIN users u ON u.telegram_id=c.user_id
ON CONFLICT(chat_id,user_id) DO NOTHING;
