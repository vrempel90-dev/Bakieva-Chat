import { pool } from "./db.js";

export type InstagramReelPublication = {
  id: number;
  telegramFileId: string;
  telegramFileUniqueId: string | null;
  mimeType: string;
  caption: string;
  containerId: string | null;
  mediaId: string | null;
  automationId: number | null;
  status: "publishing" | "published" | "failed";
  error: string | null;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
};

function mapReel(row: any): InstagramReelPublication {
  return {
    id: Number(row.id),
    telegramFileId: String(row.telegram_file_id),
    telegramFileUniqueId: row.telegram_file_unique_id ? String(row.telegram_file_unique_id) : null,
    mimeType: String(row.mime_type ?? "video/mp4"),
    caption: String(row.caption ?? ""),
    containerId: row.container_id ? String(row.container_id) : null,
    mediaId: row.media_id ? String(row.media_id) : null,
    automationId: row.automation_id == null ? null : Number(row.automation_id),
    status: row.status,
    error: row.error ? String(row.error) : null,
    createdBy: Number(row.created_by),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    publishedAt: row.published_at ? new Date(row.published_at) : null
  };
}

export async function createInstagramReelPublication(input: {
  telegramFileId: string;
  telegramFileUniqueId?: string | null;
  mimeType?: string | null;
  caption?: string;
  createdBy: number;
}) {
  const r = await pool.query(
    `INSERT INTO instagram_reels(
       telegram_file_id, telegram_file_unique_id, mime_type, caption, status, created_by
     ) VALUES($1,$2,$3,$4,'publishing',$5)
     RETURNING *`,
    [
      input.telegramFileId,
      input.telegramFileUniqueId ?? null,
      input.mimeType?.trim() || "video/mp4",
      input.caption?.trim() ?? "",
      input.createdBy
    ]
  );
  return mapReel(r.rows[0]);
}

export async function markInstagramReelContainer(id: number, containerId: string) {
  const r = await pool.query(
    `UPDATE instagram_reels
     SET container_id=$2, updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [id, containerId]
  );
  return r.rowCount ? mapReel(r.rows[0]) : null;
}

export async function markInstagramReelPublished(input: {
  id: number;
  mediaId: string;
  automationId?: number | null;
  warning?: string | null;
}) {
  const r = await pool.query(
    `UPDATE instagram_reels
     SET media_id=$2,
         automation_id=$3,
         status='published',
         error=$4,
         published_at=NOW(),
         updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [input.id, input.mediaId, input.automationId ?? null, input.warning ?? null]
  );
  return r.rowCount ? mapReel(r.rows[0]) : null;
}

export async function markInstagramReelFailed(id: number, error: string) {
  const r = await pool.query(
    `UPDATE instagram_reels
     SET status='failed', error=$2, updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [id, error.slice(0, 1500)]
  );
  return r.rowCount ? mapReel(r.rows[0]) : null;
}

export async function listInstagramReelPublications(limit = 5) {
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  const r = await pool.query(
    `SELECT *
     FROM instagram_reels
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return r.rows.map(mapReel);
}
