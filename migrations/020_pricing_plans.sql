CREATE TABLE IF NOT EXISTS pricing_entitlements (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('legacy_5000','standard')),
  source TEXT NOT NULL DEFAULT 'manual',
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pricing_entitlements_tier_idx
  ON pricing_entitlements(tier, updated_at);

-- Freeze the promotional cohort from members/subscribers already known by the bot
-- before the new pricing is enabled. New users are NOT added automatically later.
INSERT INTO pricing_entitlements(user_id, tier, source)
SELECT DISTINCT user_id, 'legacy_5000', '2026-10-06_snapshot'
FROM (
  SELECT user_id
  FROM current_chat_members
  WHERE is_active=TRUE

  UNION

  SELECT user_id
  FROM legacy_members

  UNION

  SELECT user_id
  FROM subscriptions
  WHERE status='active' AND active_until>NOW()
) existing_members
ON CONFLICT(user_id) DO NOTHING;
