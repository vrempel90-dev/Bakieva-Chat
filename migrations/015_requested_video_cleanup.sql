-- Explicit owner request on 2026-09-30: remove all previously uploaded bot videos.
-- This migration schedules one operation; the worker runs after taking the poller
-- lock, when the previous deployment can no longer upload replacement content.
INSERT INTO settings(key, value)
VALUES (
  'maintenance_video_cleanup_20260930',
  '{"status":"pending","requestedAt":"2026-09-30T17:00:28Z"}'
)
ON CONFLICT(key) DO NOTHING;

-- Stale seed URLs must never refill the emptied trial-video store on restart.
INSERT INTO settings(key, value)
VALUES ('media_video_seed_disabled', 'true')
ON CONFLICT(key) DO UPDATE SET value='true', updated_at=NOW();
