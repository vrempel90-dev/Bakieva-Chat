import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export const REQUESTED_TRIAL_UPLOAD_KEY = "maintenance_trial_upload_20260930";
export const REQUESTED_TRIAL_PLAYBACK_KEY = "maintenance_trial_playback_upload_20261001";
type RequestKey = typeof REQUESTED_TRIAL_UPLOAD_KEY | typeof REQUESTED_TRIAL_PLAYBACK_KEY;
export type OriginalPart = {
  filename: string; bytes: number; sha256: string; fileId?: string;
  playback?: { sourceFileId: string; width: number; height: number; duration: number };
};
type UploadRequest = {
  status: "pending" | "done";
  expiresAt: string;
  secretSha256: string;
  parts: Record<string, OriginalPart>;
  completedAt?: string;
};

export async function authorizeRequestedTrialUpload(
  database: Pick<Pool, "query">,
  secret: string,
  language: "ru" | "kk",
  part: "part1" | "part2",
  requestKey: RequestKey = REQUESTED_TRIAL_UPLOAD_KEY
): Promise<OriginalPart | null> {
  if (!secret) return null;
  const result = await database.query("SELECT value FROM settings WHERE key=$1", [requestKey]);
  if (!result.rowCount) return null;
  const request = JSON.parse(String(result.rows[0].value)) as UploadRequest;
  const expiresAt = Date.parse(request.expiresAt);
  if (request.status !== "pending" || !Number.isFinite(expiresAt) || expiresAt <= Date.now() ||
    !/^[a-f0-9]{64}$/.test(request.secretSha256)) return null;
  const provided = createHash("sha256").update(secret).digest();
  if (!timingSafeEqual(provided, Buffer.from(request.secretSha256, "hex"))) return null;
  const original = request.parts[`${language}_${part}`];
  return original && !original.fileId ? original : null;
}

export function verifyRequestedTrialBytes(original: OriginalPart, bytes: Buffer) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== original.bytes || sha256 !== original.sha256) {
    throw new Error("original_file_mismatch");
  }
  return sha256;
}

export async function completeRequestedTrialUpload(
  database: Pick<Pool, "connect">,
  language: "ru" | "kk",
  part: "part1" | "part2",
  fileId: string,
  requestKey: RequestKey = REQUESTED_TRIAL_UPLOAD_KEY
) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT value FROM settings WHERE key=$1 FOR UPDATE", [requestKey]);
    if (!result.rowCount) throw new Error("upload_request_missing");
    const request = JSON.parse(String(result.rows[0].value)) as UploadRequest;
    const original = request.parts[`${language}_${part}`];
    if (!original || !fileId || original.fileId || request.status !== "pending") {
      throw new Error("upload_request_invalid");
    }
    original.fileId = fileId;
    let activated = false;
    if (requestKey === REQUESTED_TRIAL_PLAYBACK_KEY) {
      const first = request.parts[`${language}_part1`];
      const second = request.parts[`${language}_part2`];
      const keys = [`trial_video_file_id_${language}_part1`, `trial_video_file_id_${language}_part2`];
      const sources = await client.query(
        "SELECT key, value FROM settings WHERE key=ANY($1::text[]) FOR UPDATE", [keys]);
      const values = new Map<string, string>(sources.rows.map(row => [row.key, row.value]));
      if (!first?.playback?.sourceFileId || !second?.playback?.sourceFileId ||
        values.get(keys[0]) !== first.playback.sourceFileId ||
        values.get(keys[1]) !== second.playback.sourceFileId) {
        throw new Error("trial_originals_changed");
      }
      if (first.fileId && second.fileId) {
        await client.query(`INSERT INTO settings(key,value) VALUES($1,$2)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [
          `trial_video_playback_${language}`, JSON.stringify({
            sourcePart1: first.playback.sourceFileId, sourcePart2: second.playback.sourceFileId,
            part1: first.fileId, part2: second.fileId
          })
        ]);
        activated = true;
      }
    }
    if (["ru_part1", "ru_part2", "kk_part1", "kk_part2"].every(key => request.parts[key]?.fileId)) {
      request.status = "done";
      request.completedAt = new Date().toISOString();
      request.secretSha256 = "";
    }
    await client.query("UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1", [
      requestKey, JSON.stringify(request)
    ]);
    await client.query("COMMIT");
    return { activated };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
