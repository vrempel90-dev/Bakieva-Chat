CREATE TABLE IF NOT EXISTS content_posts (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('video','news')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','deleted')),
  audience TEXT CHECK (audience IN ('all','active')),
  title TEXT,
  body TEXT,
  telegram_file_id TEXT,
  telegram_file_unique_id TEXT,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  notified_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS content_posts_published_idx
  ON content_posts(published_at DESC)
  WHERE status='published';

CREATE INDEX IF NOT EXISTS content_posts_status_idx
  ON content_posts(status, created_at DESC);
