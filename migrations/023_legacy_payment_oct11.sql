-- Align the grandfathered 5 000 KZT cohort with the client's real renewal date:
-- 11 October 2026. This also backfills old clients that were already recognized by
-- pricing_entitlements before legacy_members existed for them.

INSERT INTO legacy_members(user_id, cohort, expires_at)
SELECT user_id, '2026-10-11', TIMESTAMPTZ '2026-10-11 23:59:59+05'
FROM pricing_entitlements
WHERE tier='legacy_5000'
ON CONFLICT(user_id) DO UPDATE SET
  cohort=EXCLUDED.cohort,
  expires_at=EXCLUDED.expires_at;

INSERT INTO subscriptions(user_id,status,active_until)
SELECT user_id, 'active', TIMESTAMPTZ '2026-10-11 23:59:59+05'
FROM pricing_entitlements
WHERE tier='legacy_5000'
ON CONFLICT(user_id) DO UPDATE SET
  status='active',
  active_until=GREATEST(subscriptions.active_until, EXCLUDED.active_until),
  last_reminder_at=NULL,
  updated_at=NOW();

INSERT INTO settings(key,value)
VALUES
  ('legacy_payment_date','2026-10-11'),
  ('legacy_oct11_dm_sent_at',''),
  ('legacy_oct11_dm_stats',''),
  ('legacy_oct11_group_sent_at','')
ON CONFLICT(key) DO UPDATE SET
  value=EXCLUDED.value,
  updated_at=NOW();
