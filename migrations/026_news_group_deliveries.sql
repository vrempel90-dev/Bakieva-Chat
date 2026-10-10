CREATE TABLE IF NOT EXISTS content_news_deliveries (
  content_post_id BIGINT NOT NULL REFERENCES content_posts(id) ON DELETE CASCADE,
  target_chat_id BIGINT NOT NULL,
  target_title TEXT NOT NULL,
  target_username TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent','partial','failed')),
  telegram_message_id BIGINT,
  error_text TEXT,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (content_post_id, target_chat_id)
);

CREATE INDEX IF NOT EXISTS content_news_deliveries_status_idx
  ON content_news_deliveries(content_post_id, status);
