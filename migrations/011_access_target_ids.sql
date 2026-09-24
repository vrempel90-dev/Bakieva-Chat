-- Keep previously issued links tied to the destination for which they were created.
ALTER TABLE access_deliveries ADD COLUMN IF NOT EXISTS channel_chat_id BIGINT;
ALTER TABLE access_deliveries ADD COLUMN IF NOT EXISTS main_chat_id BIGINT;
-- Revocation in an existing community group only applies to joins approved by the paid flow.
ALTER TABLE access_deliveries ADD COLUMN IF NOT EXISTS main_chat_join_approved_at TIMESTAMPTZ;
