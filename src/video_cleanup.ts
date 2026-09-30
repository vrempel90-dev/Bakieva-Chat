import type { Bot } from "grammy";
import type { Pool } from "pg";

export const VIDEO_CLEANUP_KEY = "maintenance_video_cleanup_20260930";

type TelegramDeletion = {
  chatId: number;
  messageId: number;
  status: "pending" | "deleted" | "unavailable";
  errorCode?: number;
};
type CleanupState = {
  status: "pending" | "database_deleted" | "done";
  requestedAt: string;
  completedAt?: string;
  contentVideos?: number;
  trialAssets?: number;
  reelUploads?: number;
  videoSettings?: number;
  unboundMessages?: number;
  messages?: TelegramDeletion[];
};

export async function runRequestedVideoCleanup(
  database: Pick<Pool, "connect" | "query">,
  api: Pick<Bot["api"], "deleteMessage">,
  paidChatId: number
) {
  const client = await database.connect();
  let state: CleanupState | null = null;
  try {
    await client.query("BEGIN");
    const marker = await client.query(
      "SELECT value FROM settings WHERE key=$1 FOR UPDATE", [VIDEO_CLEANUP_KEY]
    );
    if (!marker.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    state = JSON.parse(String(marker.rows[0].value)) as CleanupState;
    if (state.status === "done") {
      await client.query("COMMIT");
      return state;
    }
    if (state.status !== "pending" && state.status !== "database_deleted") {
      throw new Error("Invalid video cleanup state");
    }

    if (state.status === "pending") {
      const messageSettings = await client.query(
        "SELECT key, value FROM settings WHERE key LIKE 'trial_video_message_id_%'"
      );
      const messageIds = [...new Set<number>(messageSettings.rows
        .map(row => Number(row.value))
        .filter(id => Number.isSafeInteger(id) && id > 0))];
      const bound = Number.isSafeInteger(paidChatId) && paidChatId !== 0;
      const posts = await client.query("DELETE FROM content_posts WHERE kind='video' RETURNING id");
      const assets = await client.query("DELETE FROM trial_video_assets RETURNING language");
      const reels = await client.query("DELETE FROM instagram_reels RETURNING id");
      const settings = await client.query(
        "DELETE FROM settings WHERE key LIKE 'trial_video_%' RETURNING key"
      );
      // Explicit empty overrides also suppress the legacy environment URL fallback.
      for (const key of ["trial_url", "trial_url_ru", "trial_url_kk"]) {
        await client.query(
          `INSERT INTO settings(key,value) VALUES($1,'')
           ON CONFLICT(key) DO UPDATE SET value='', updated_at=NOW()`, [key]
        );
      }
      await client.query(
        `INSERT INTO settings(key,value) VALUES('media_video_sources_revoked_before_ms',$1)
         ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
        [String(Date.now())]
      );
      state = {
        status: "database_deleted",
        requestedAt: state.requestedAt,
        contentVideos: posts.rowCount ?? 0,
        trialAssets: assets.rowCount ?? 0,
        reelUploads: reels.rowCount ?? 0,
        videoSettings: settings.rowCount ?? 0,
        unboundMessages: bound ? 0 : messageIds.length,
        messages: bound ? messageIds.map(messageId => ({
          chatId: paidChatId, messageId, status: "pending" as const
        })) : []
      };
      const remaining = await client.query(
        `SELECT
          (SELECT COUNT(*) FROM content_posts WHERE kind='video') AS content_videos,
          (SELECT COUNT(*) FROM trial_video_assets) AS trial_assets,
          (SELECT COUNT(*) FROM instagram_reels) AS reel_uploads,
          (SELECT COUNT(*) FROM settings WHERE key LIKE 'trial_video_%') AS video_settings`
      );
      const counts = remaining.rows[0];
      if (!counts || ["content_videos", "trial_assets", "reel_uploads", "video_settings"]
        .some(key => counts[key] == null || Number(counts[key]) !== 0)) {
        throw new Error("Video cleanup verification failed");
      }
      await client.query(
        "UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1",
        [VIDEO_CLEANUP_KEY, JSON.stringify(state)]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // A persisted queue allows retrying the old messages without deleting any new
  // uploads. Only known trial-message IDs in the legacy paid-chat destination
  // are used; other chats and viewer copies are never guessed.
  for (const message of state.messages ?? []) {
    if (message.status !== "pending") continue;
    try {
      await api.deleteMessage(message.chatId, message.messageId);
      message.status = "deleted";
      delete message.errorCode;
    } catch (error) {
      const code = Number((error as { error_code?: number }).error_code) || 0;
      message.errorCode = code;
      if (code === 400 || code === 403) message.status = "unavailable";
    }
    await database.query(
      "UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1",
      [VIDEO_CLEANUP_KEY, JSON.stringify(state)]
    );
  }
  const pending = (state.messages ?? []).filter(message => message.status === "pending").length;
  state.status = pending ? "database_deleted" : "done";
  if (!pending) state.completedAt = new Date().toISOString();
  await database.query(
    "UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1",
    [VIDEO_CLEANUP_KEY, JSON.stringify(state)]
  );
  console.info(JSON.stringify({
    event: "requested_video_cleanup",
    status: state.status,
    contentVideos: state.contentVideos,
    trialAssets: state.trialAssets,
    reelUploads: state.reelUploads,
    videoSettings: state.videoSettings,
    telegramDeleted: (state.messages ?? []).filter(message => message.status === "deleted").length,
    telegramUnavailable: (state.messages ?? []).filter(message => message.status === "unavailable").length,
    telegramUnbound: state.unboundMessages,
    telegramPending: pending,
    remainingVideos: 0
  }));
  return state;
}
