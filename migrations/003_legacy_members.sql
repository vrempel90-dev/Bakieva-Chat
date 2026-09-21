CREATE TABLE IF NOT EXISTS legacy_members (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  cohort TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS legacy_members_cohort_idx
  ON legacy_members(cohort, expires_at);
