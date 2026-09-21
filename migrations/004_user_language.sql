ALTER TABLE users
  ADD COLUMN IF NOT EXISTS language TEXT;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_language_check;

ALTER TABLE users
  ADD CONSTRAINT users_language_check
  CHECK (language IS NULL OR language IN ('ru','kk'));

CREATE INDEX IF NOT EXISTS users_language_idx
  ON users(language);
