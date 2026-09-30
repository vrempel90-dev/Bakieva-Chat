import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

export const REQUESTED_TRIAL_UPLOAD_KEY = "maintenance_trial_upload_20260930";
type OriginalPart = { filename: string; bytes: number; sha256: string; fileId?: string };
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
  part: "part1" | "part2"
): Promise<OriginalPart | null> {
  if (!secret) return null;
  const result = await database.query("SELECT value FROM settings WHERE key=$1", [REQUESTED_TRIAL_UPLOAD_KEY]);
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
  fileId: string
) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT value FROM settings WHERE key=$1 FOR UPDATE", [REQUESTED_TRIAL_UPLOAD_KEY]);
    if (!result.rowCount) throw new Error("upload_request_missing");
    const request = JSON.parse(String(result.rows[0].value)) as UploadRequest;
    const original = request.parts[`${language}_${part}`];
    if (!original || !fileId) throw new Error("upload_request_invalid");
    original.fileId = fileId;
    if (["ru_part1", "ru_part2", "kk_part1", "kk_part2"].every(key => request.parts[key]?.fileId)) {
      request.status = "done";
      request.completedAt = new Date().toISOString();
      request.secretSha256 = "";
    }
    await client.query("UPDATE settings SET value=$2, updated_at=NOW() WHERE key=$1", [
      REQUESTED_TRIAL_UPLOAD_KEY, JSON.stringify(request)
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
