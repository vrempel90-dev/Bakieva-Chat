-- Non-destructive extension of the existing railway-stable schema (001..028).
CREATE TABLE IF NOT EXISTS buyer_profiles (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  whatsapp_e164 TEXT,
  whatsapp_confirmed_at TIMESTAMPTZ,
  data_consent_at TIMESTAMPTZ,
  data_consent_version TEXT,
  marketing_consent_at TIMESTAMPTZ,
  pending_whatsapp_e164 TEXT,
  pending_token TEXT,
  awaiting_phone BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_whatsapp CHECK (
    whatsapp_e164 IS NULL OR (
      LEFT(whatsapp_e164,1)='+' AND LENGTH(whatsapp_e164) BETWEEN 9 AND 16
      AND SUBSTRING(whatsapp_e164 FROM 2) ~ '^[1-9][0-9]{7,14}$'
    )
  ),
  CONSTRAINT valid_pending_whatsapp CHECK (
    pending_whatsapp_e164 IS NULL OR (
      LEFT(pending_whatsapp_e164,1)='+' AND LENGTH(pending_whatsapp_e164) BETWEEN 9 AND 16
      AND SUBSTRING(pending_whatsapp_e164 FROM 2) ~ '^[1-9][0-9]{7,14}$'
    )
  )
);
CREATE INDEX IF NOT EXISTS idx_approved_payments_day ON payments(approved_at)
 WHERE status='approved';
CREATE TABLE IF NOT EXISTS buyer_sales_report_deliveries (
  admin_id BIGINT NOT NULL,
  report_day DATE NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','sent','uncertain','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  PRIMARY KEY (admin_id,report_day)
);
-- Existing payment and subscription rows are untouched.
