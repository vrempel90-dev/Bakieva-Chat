CREATE TABLE IF NOT EXISTS trial_video_assets (
  language TEXT PRIMARY KEY CHECK (language IN ('ru','kk')),
  content BYTEA,
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  telegram_file_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
