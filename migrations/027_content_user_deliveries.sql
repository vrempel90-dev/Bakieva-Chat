CREATE TABLE IF NOT EXISTS content_user_deliveries (
  content_post_id BIGINT NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  telegram_message_id BIGINT,
  error_text TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (content_post_id, user_id)
);

CREATE INDEX IF NOT EXISTS content_user_deliveries_status_idx
  ON content_user_deliveries(content_post_id, status, user_id);
