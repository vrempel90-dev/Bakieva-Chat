CREATE TABLE IF NOT EXISTS post_bot_members (
  user_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  first_joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'unknown',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS post_bot_members_joined_idx
  ON post_bot_members(first_joined_at);

-- Reliable historical backfill: users whose paid-chat join was approved by the bot.
INSERT INTO post_bot_members(user_id, first_joined_at, source)
SELECT user_id, main_chat_join_approved_at, 'managed_join_approval'
FROM access_deliveries
WHERE main_chat_join_approved_at IS NOT NULL
ON CONFLICT(user_id) DO NOTHING;

-- Everyone explicitly classified as standard pricing entered after the pricing cutoff,
-- which is later than the bot installation, so they are also post-bot users.
INSERT INTO post_bot_members(user_id, first_joined_at, source)
SELECT user_id, assigned_at, 'standard_pricing'
FROM pricing_entitlements
WHERE tier='standard'
ON CONFLICT(user_id) DO NOTHING;
