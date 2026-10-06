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
  FROM payments
  WHERE status='approved'
    AND amount=5000
    AND approved_at < TIMESTAMPTZ '2026-10-08 00:00:00+06'
) existing_members
ON CONFLICT(user_id) DO NOTHING;


-- The current production Kaspi Pay destination from railway-stable.
-- Storing it in settings makes later changes possible through /kaspi_url without redeploy.
INSERT INTO settings(key,value)
VALUES('kaspi_pay_url','https://pay.kaspi.kz/pay/8j1mpcx4')
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  updated_at=NOW();
