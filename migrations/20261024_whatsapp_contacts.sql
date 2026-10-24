-- Phone numbers provided by users after confirmed payment.
-- Retain only a single contact per Telegram user; do not expose it in logs.
CREATE TABLE IF NOT EXISTS user_whatsapp_contacts (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  phone TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
