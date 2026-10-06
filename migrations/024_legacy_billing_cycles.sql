CREATE TABLE IF NOT EXISTS legacy_manual_invites (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by BIGINT,
  bound_user_id BIGINT REFERENCES users(telegram_id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS legacy_manual_invites_expires_idx
  ON legacy_manual_invites(expires_at)
  WHERE claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS legacy_billing_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  renewal_day SMALLINT NOT NULL CHECK (renewal_day BETWEEN 1 AND 31),
  next_due_date DATE NOT NULL,
  source TEXT NOT NULL,
  last_reminder_for DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS legacy_billing_due_idx
  ON legacy_billing_profiles(next_due_date, last_reminder_for);

-- Existing clients who already paid 5 000 KZT through the bot keep that price.
-- Reconstruct their current cycle from the latest approved 5k payment.
WITH latest_5k AS (
  SELECT DISTINCT ON (p.user_id)
    p.user_id,
    COALESCE(
      CASE
        WHEN (p.meta->>'receipt_date') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        THEN (p.meta->>'receipt_date')::timestamptz
        ELSE NULL
      END,
      p.approved_at,
      p.requested_at
    ) AS paid_at
  FROM payments p
  WHERE p.status='approved' AND p.amount=5000
  ORDER BY p.user_id, COALESCE(p.approved_at, p.requested_at) DESC, p.id DESC
),
cycles AS (
  SELECT
    user_id,
    ((paid_at AT TIME ZONE 'Asia/Almaty')::date + interval '30 days')::date AS next_due_date
  FROM latest_5k
)
INSERT INTO legacy_billing_profiles(user_id, renewal_day, next_due_date, source)
SELECT
  user_id,
  EXTRACT(DAY FROM next_due_date)::int,
  next_due_date,
  'existing_bot_5000'
FROM cycles
ON CONFLICT(user_id) DO NOTHING;

-- Ensure the same already-paid 5k customers keep the legacy tariff.
INSERT INTO pricing_entitlements(user_id, tier, source)
SELECT user_id, 'legacy_5000', 'existing_bot_5000'
FROM legacy_billing_profiles
ON CONFLICT(user_id) DO UPDATE SET
  tier='legacy_5000',
  source=CASE
    WHEN pricing_entitlements.tier='legacy_5000' THEN pricing_entitlements.source
    ELSE EXCLUDED.source
  END,
  updated_at=NOW();

-- Old global 11 October reminders are no longer used.
INSERT INTO settings(key,value)
VALUES
  ('legacy_5000_claim_closed_at', NOW()::text),
  ('legacy_oct11_dm_sent_at', 'disabled'),
  ('legacy_oct11_group_sent_at', 'disabled')
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  updated_at=NOW();
