-- Keeps payment confirmation separate from fallible Telegram delivery.
CREATE TABLE IF NOT EXISTS access_deliveries (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id),
  subscription_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'access_pending'
    CHECK (status IN ('access_pending','access_partial','access_failed','access_delivered',
                     'access_configuration_error','access_telegram_error')),
  channel_invite TEXT,
  channel_invite_expires_at TIMESTAMPTZ,
  main_chat_invite TEXT,
  main_chat_invite_expires_at TIMESTAMPTZ,
  channel_ready BOOLEAN NOT NULL DEFAULT FALSE,
  main_chat_ready BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0,
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS access_deliveries_retry_idx
  ON access_deliveries(next_retry_at) WHERE status <> 'access_delivered' AND retryable;
