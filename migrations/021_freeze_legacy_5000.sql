-- Freeze the old 5 000 KZT cohort at deployment time.
-- After this migration no new user can self-claim legacy_5000.
INSERT INTO pricing_entitlements(user_id, tier, source)
SELECT DISTINCT user_id, 'legacy_5000', 'frozen_current_clients'
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
    AND approved_at <= NOW()
) old_clients
ON CONFLICT(user_id) DO UPDATE SET
  tier='legacy_5000',
  source=CASE
    WHEN pricing_entitlements.tier='legacy_5000' THEN pricing_entitlements.source
    ELSE EXCLUDED.source
  END,
  updated_at=NOW();

INSERT INTO settings(key,value)
VALUES
  ('legacy_5000_frozen_at', NOW()::text),
  ('legacy_5000_claim_closed_at', NOW()::text)
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  updated_at=NOW();
