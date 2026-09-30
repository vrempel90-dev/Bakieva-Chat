-- Owner requested removal of the four newly uploaded trial copies from the chat.
-- Original document file IDs and RU/KZ trial settings must remain untouched.
INSERT INTO settings(key,value)
VALUES ('maintenance_trial_chat_cleanup_20260930', '{"status":"pending","requestedAt":"2026-09-30T17:48:42Z"}')
ON CONFLICT(key) DO NOTHING;
