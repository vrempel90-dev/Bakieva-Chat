ALTER TABLE users
  ADD COLUMN IF NOT EXISTS language TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_language_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_language_check
      CHECK (language IS NULL OR language IN ('ru','kk'));
  END IF;
END $$;
