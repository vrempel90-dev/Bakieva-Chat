ALTER TABLE content_posts
  ADD COLUMN IF NOT EXISTS telegram_media_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'content_posts_telegram_media_type_check'
  ) THEN
    ALTER TABLE content_posts
      ADD CONSTRAINT content_posts_telegram_media_type_check
      CHECK (
        telegram_media_type IS NULL OR
        telegram_media_type IN ('video', 'document', 'photo')
      );
  END IF;
END
$$;

UPDATE content_posts
SET telegram_media_type = 'video'
WHERE kind = 'video'
  AND telegram_file_id IS NOT NULL
  AND telegram_media_type IS NULL;
