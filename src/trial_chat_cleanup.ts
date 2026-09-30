import type { Bot } from "grammy";
import type { Pool } from "pg";
import { REQUESTED_TRIAL_UPLOAD_KEY } from "./requested_trial_upload.js";

export const TRIAL_CHAT_CLEANUP_KEY = "maintenance_trial_chat_cleanup_20260930";
const parts = ["ru_part1", "ru_part2", "kk_part1", "kk_part2"];
const originalKeys = parts.flatMap(part => [`trial_video_file_id_${part}`, `trial_video_media_type_${part}`]);
type ChatCopy = { key: string; chatId: number; messageId: number; status: "pending" | "deleted" | "absent"; errorCode?: number };
type Cleanup = { status: "pending" | "captured" | "done"; requestedAt: string;
  originals?: Record<string,string>; messages?: ChatCopy[] };

export async function removeRequestedTrialChatCopies(
  database: Pick<Pool,"connect"|"query">,
  api: Pick<Bot["api"],"deleteMessage">,
  paidChatId: number
) {
  const client = await database.connect();
  let state: Cleanup;
  try {
    await client.query("BEGIN");
    const marker = await client.query("SELECT value FROM settings WHERE key=$1 FOR UPDATE", [TRIAL_CHAT_CLEANUP_KEY]);
    if (!marker.rowCount) { await client.query("COMMIT"); return null; }
    state = JSON.parse(String(marker.rows[0].value)) as Cleanup;
    if (state.status === "done") { await client.query("COMMIT"); return state; }
    if (state.status === "pending") {
      if (!Number.isSafeInteger(paidChatId) || !paidChatId) throw new Error("Trial chat destination missing");
      const upload = await client.query("SELECT value FROM settings WHERE key=$1", [REQUESTED_TRIAL_UPLOAD_KEY]);
      const requested = JSON.parse(String(upload.rows[0]?.value ?? "null"));
      const rows = await client.query("SELECT key,value FROM settings WHERE key=ANY($1::text[])", [
        [...originalKeys, ...parts.map(part => `trial_video_message_id_${part}`)]
      ]);
      const values = new Map<string,string>(rows.rows.map(row => [String(row.key),String(row.value)]));
      const messages: ChatCopy[] = [];
      for (const part of parts) {
        const fileId = values.get(`trial_video_file_id_${part}`);
        if (!fileId || fileId !== requested?.parts?.[part]?.fileId ||
          values.get(`trial_video_media_type_${part}`) !== "document") {
          throw new Error("Requested trial originals not confirmed");
        }
        const key = `trial_video_message_id_${part}`;
        const messageId = Number(values.get(key));
        if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error("Trial chat message missing");
        messages.push({ key, chatId: paidChatId, messageId, status: "pending" });
      }
      state = { ...state, status: "captured", messages,
        originals: Object.fromEntries(originalKeys.map(key => [key,values.get(key)!])) };
      await client.query("UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1", [TRIAL_CHAT_CLEANUP_KEY,JSON.stringify(state)]);
    }
    if (state.status !== "captured") throw new Error("Invalid trial chat cleanup state");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }

  for (const message of state.messages ?? []) {
    if (message.status !== "pending") continue;
    try {
      await api.deleteMessage(message.chatId,message.messageId);
      message.status = "deleted";
      delete message.errorCode;
    } catch (error) {
      const telegram = error as { error_code?: number; description?: string };
      message.errorCode = Number(telegram.error_code) || 0;
      if (telegram.error_code === 400 && telegram.description?.includes("message to delete not found")) {
        message.status = "absent";
      }
    }
    if (message.status !== "pending") {
      await database.query("DELETE FROM settings WHERE key=$1 AND value=$2", [message.key,String(message.messageId)]);
    }
    await database.query("UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1", [TRIAL_CHAT_CLEANUP_KEY,JSON.stringify(state)]);
  }
  const remaining = await database.query("SELECT key,value FROM settings WHERE key=ANY($1::text[])", [originalKeys]);
  const preserved = new Map<string,string>(remaining.rows.map(row => [String(row.key),String(row.value)]));
  if (originalKeys.some(key => preserved.get(key) !== state.originals?.[key])) {
    throw new Error("Trial originals preservation check failed");
  }
  if (state.messages?.every(message => message.status !== "pending")) state.status = "done";
  await database.query("UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1", [TRIAL_CHAT_CLEANUP_KEY,JSON.stringify(state)]);
  console.info(JSON.stringify({ event: "requested_trial_chat_cleanup", status: state.status,
    deletedMessages: state.messages?.filter(message => message.status === "deleted").length,
    alreadyAbsent: state.messages?.filter(message => message.status === "absent").length,
    pendingMessages: state.messages?.filter(message => message.status === "pending").length,
    trialPartsPreserved: parts.length, documentParts: parts.length }));
  return state;
}
