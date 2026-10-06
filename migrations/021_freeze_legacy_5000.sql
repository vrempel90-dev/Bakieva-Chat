-- Freeze the pricing transition moment.
-- Existing known 5 000 KZT customers become legacy immediately.
-- Unknown old members can still self-identify from the old paid chat.
-- Every NEW join after this migration is marked as standard pricing by the bot.

INSERT INTO pricing_entitlements(user_id, tier, source)
SELECT DISTINCT user_id, 'legacy_5000', 'pricing_cutoff_snapshot'
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
  tier=CASE
    WHEN pricing_entitlements.tier='standard' THEN pricing_entitlements.tier
    ELSE 'legacy_5000'
  END,
  source=CASE
    WHEN pricing_entitlements.tier='standard' THEN pricing_entitlements.source
    ELSE EXCLUDED.source
  END,
  updated_at=NOW();

INSERT INTO settings(key,value)
VALUES
  ('legacy_5000_cutoff_at', NOW()::text),
  ('legacy_5000_frozen_at', NOW()::text),
  ('legacy_5000_claim_closed_at', '')
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  updated_at=NOW();
