-- Additive migration. Legacy purchases retain unknown historical terms as NULL.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY CHECK (id IN ('month','half_year')),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price BETWEEN 1 AND 100000000),
  days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 3650),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ALTER COLUMN marketing_opt_in SET DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_consented_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp TEXT CHECK (whatsapp ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_provided_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS data_consent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS data_consent_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_state TEXT NOT NULL DEFAULT 'idle'
  CHECK (profile_state IN ('idle','awaiting_phone','confirm_phone'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_candidate TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_token TEXT;
-- Existing TRUE values were an automatic default, not evidence of explicit consent.
UPDATE users SET marketing_opt_in=FALSE WHERE marketing_consented_at IS NULL;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_name TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_days INTEGER CHECK (plan_days BETWEEN 1 AND 3650);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS buyer_name TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS buyer_username TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS whatsapp TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS whatsapp_provided_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS data_consent_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS data_consent_version TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS marketing_consented_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS subscription_start TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS subscription_end TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS legacy BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE payments ALTER COLUMN legacy SET DEFAULT FALSE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS access_status TEXT NOT NULL DEFAULT 'waiting_payment'
  CHECK (access_status IN ('waiting_payment','waiting_profile','ready','invited','partial','granted','revoked','expired','legacy'));
UPDATE payments SET plan_id='legacy', plan_name='Архивный тариф',
  claimed_at=requested_at, access_status=CASE WHEN status='approved' THEN 'legacy' ELSE 'waiting_payment' END
  WHERE legacy=TRUE AND plan_id IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_new_plan' AND conrelid='payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT payment_new_plan CHECK
      (legacy OR (plan_id IS NOT NULL AND plan_id IN ('month','half_year') AND plan_name IS NOT NULL AND plan_days IS NOT NULL AND amount>0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='payment_activation' AND conrelid='payments'::regclass) THEN
    ALTER TABLE payments ADD CONSTRAINT payment_activation CHECK
      (activated_at IS NULL OR (status='approved' AND subscription_start IS NOT NULL AND subscription_end IS NOT NULL AND subscription_end>subscription_start));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS payments_approved_date ON payments(approved_at,id) WHERE status='approved';
CREATE INDEX IF NOT EXISTS payments_user_history ON payments(user_id,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS payments_selection_update ON payments(user_id,(meta->>'selection_update_id'));
CREATE INDEX IF NOT EXISTS payments_waiting_profile ON payments(user_id) WHERE status='approved' AND activated_at IS NULL;
CREATE INDEX IF NOT EXISTS subscriptions_expiry ON subscriptions(active_until) WHERE status='active';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS access_removed_at TIMESTAMPTZ;
ALTER TABLE chat_memberships ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;
UPDATE chat_memberships m SET last_event_at=(SELECT MAX(event_at) FROM membership_events e WHERE e.chat_id=m.chat_id AND e.user_id=m.user_id)
  WHERE last_event_at IS NULL;
ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_user_id_fkey;
ALTER TABLE payments ADD CONSTRAINT payments_user_id_fkey FOREIGN KEY(user_id) REFERENCES users(telegram_id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS access_invites (
  user_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  invite_link TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  joined_at TIMESTAMPTZ,
  PRIMARY KEY(user_id,chat_id)
);
CREATE TABLE IF NOT EXISTS admin_actions (
  update_id BIGINT PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  action TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS admin_flows (
  admin_id BIGINT PRIMARY KEY,
  action TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS report_deliveries (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE NOT NULL,
  admin_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','uncertain')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  UNIQUE(report_date,admin_id)
);
CREATE TABLE IF NOT EXISTS report_parts (
  delivery_id BIGINT NOT NULL REFERENCES report_deliveries(id) ON DELETE CASCADE,
  part INTEGER NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','uncertain')),
  message_id BIGINT,
  PRIMARY KEY(delivery_id,part)
);
