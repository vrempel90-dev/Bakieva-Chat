ALTER TABLE trial_video_assets
  ADD COLUMN IF NOT EXISTS telegram_media_type TEXT NOT NULL DEFAULT 'video'
    CHECK (telegram_media_type IN ('video', 'document')),
  ADD COLUMN IF NOT EXISTS filename TEXT NOT NULL DEFAULT 'trial.mp4';
