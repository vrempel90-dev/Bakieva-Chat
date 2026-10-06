-- Correct any post-cutoff/new-pricing customer that may have been seen in the paid chat
-- before join classification was enabled. A historical approved 5 000 KZT payment keeps
-- grandfathered pricing; otherwise an approved 10 000/25 000 KZT plan is standard pricing.

UPDATE pricing_entitlements pe
SET tier='standard',
    source='approved_new_pricing_payment',
    updated_at=NOW()
WHERE pe.tier='legacy_5000'
  AND EXISTS (
    SELECT 1
    FROM payments p
    WHERE p.user_id=pe.user_id
      AND p.status='approved'
      AND (
        p.meta->>'plan_code' IN ('monthly','five_months')
        OR p.amount IN (10000,25000)
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM payments p5
    WHERE p5.user_id=pe.user_id
      AND p5.status='approved'
      AND p5.amount=5000
      AND p5.approved_at <= COALESCE(
        NULLIF((SELECT value FROM settings WHERE key='legacy_5000_cutoff_at'),'')::timestamptz,
        NOW()
      )
  );
