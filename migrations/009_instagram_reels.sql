CREATE TABLE IF NOT EXISTS instagram_reels (
  id BIGSERIAL PRIMARY KEY,
  telegram_file_id TEXT NOT NULL,
  telegram_file_unique_id TEXT,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  caption TEXT NOT NULL DEFAULT '',
  container_id TEXT,
  media_id TEXT,
  automation_id BIGINT REFERENCES instagram_automations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('publishing', 'published', 'failed')),
  error TEXT,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS instagram_reels_status_created_idx
  ON instagram_reels(status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS instagram_reels_media_id_unique_idx
  ON instagram_reels(media_id)
  WHERE media_id IS NOT NULL;
