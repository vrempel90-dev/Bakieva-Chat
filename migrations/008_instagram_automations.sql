CREATE TABLE IF NOT EXISTS instagram_automations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('all_media', 'media')),
  media_id TEXT,
  match_mode TEXT NOT NULL CHECK (match_mode IN ('all', 'keywords')),
  keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  dm_text TEXT NOT NULL,
  public_reply_text TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (scope = 'all_media' AND media_id IS NULL)
    OR
    (scope = 'media' AND media_id IS NOT NULL AND length(media_id) > 0)
  )
);

CREATE INDEX IF NOT EXISTS instagram_automations_enabled_idx
  ON instagram_automations(enabled, scope, media_id);

CREATE TABLE IF NOT EXISTS instagram_comment_deliveries (
  comment_id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  automation_id BIGINT NOT NULL REFERENCES instagram_automations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS instagram_comment_deliveries_automation_idx
  ON instagram_comment_deliveries(automation_id, created_at DESC);
