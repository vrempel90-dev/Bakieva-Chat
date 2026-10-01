ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_name TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_user_status_approved_at
  ON payments(user_id, status, approved_at DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status_active_until
  ON subscriptions(status, active_until);
