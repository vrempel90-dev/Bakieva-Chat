import { pool } from "./db.js";

export type InstagramAutomationScope = "all_media" | "media";
export type InstagramAutomationMatchMode = "all" | "keywords";

export type InstagramAutomation = {
  id: number;
  name: string;
  scope: InstagramAutomationScope;
  mediaId: string | null;
  matchMode: InstagramAutomationMatchMode;
  keywords: string[];
  dmText: string;
  enabled: boolean;
  createdBy: number;
  createdAt: Date;
  updatedAt: Date;
};

function mapAutomation(row: any): InstagramAutomation {
  return {
    id: Number(row.id),
    name: String(row.name),
    scope: row.scope,
    mediaId: row.media_id ? String(row.media_id) : null,
    matchMode: row.match_mode,
    keywords: Array.isArray(row.keywords) ? row.keywords.map(String) : [],
    dmText: String(row.dm_text),
    enabled: Boolean(row.enabled),
    createdBy: Number(row.created_by),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export async function createInstagramAutomation(input: {
  name: string;
  scope: InstagramAutomationScope;
  mediaId?: string | null;
  matchMode: InstagramAutomationMatchMode;
  keywords?: string[];
  dmText: string;
  createdBy: number;
}) {
  const r = await pool.query(
    `INSERT INTO instagram_automations(
       name, scope, media_id, match_mode, keywords, dm_text, enabled, created_by
     ) VALUES($1,$2,$3,$4,$5,$6,FALSE,$7)
     RETURNING *`,
    [
      input.name.trim().slice(0, 120),
      input.scope,
      input.scope === "media" ? input.mediaId ?? null : null,
      input.matchMode,
      input.keywords ?? [],
      input.dmText.trim(),
      input.createdBy
    ]
  );
  return mapAutomation(r.rows[0]);
}

export async function listInstagramAutomations(limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const r = await pool.query(
    `SELECT *
     FROM instagram_automations
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return r.rows.map(mapAutomation);
}

export async function getInstagramAutomation(id: number) {
  const r = await pool.query("SELECT * FROM instagram_automations WHERE id=$1", [id]);
  return r.rowCount ? mapAutomation(r.rows[0]) : null;
}

export async function toggleInstagramAutomation(id: number) {
  const r = await pool.query(
    `UPDATE instagram_automations
     SET enabled=NOT enabled, updated_at=NOW()
     WHERE id=$1
     RETURNING *`,
    [id]
  );
  return r.rowCount ? mapAutomation(r.rows[0]) : null;
}

export async function deleteInstagramAutomation(id: number) {
  const r = await pool.query(
    "DELETE FROM instagram_automations WHERE id=$1 RETURNING id",
    [id]
  );
  return Boolean(r.rowCount);
}

export async function listCandidateInstagramAutomations(mediaId: string) {
  const r = await pool.query(
    `SELECT *
     FROM instagram_automations
     WHERE enabled=TRUE
       AND (scope='all_media' OR (scope='media' AND media_id=$1))
     ORDER BY
       CASE WHEN scope='media' THEN 0 ELSE 1 END,
       created_at DESC`,
    [mediaId]
  );
  return r.rows.map(mapAutomation);
}

export async function claimInstagramComment(
  commentId: string,
  mediaId: string,
  automationId: number
) {
  const r = await pool.query(
    `INSERT INTO instagram_comment_deliveries(
       comment_id, media_id, automation_id, status
     ) VALUES($1,$2,$3,'pending')
     ON CONFLICT(comment_id) DO UPDATE SET
       media_id=EXCLUDED.media_id,
       automation_id=EXCLUDED.automation_id,
       status='pending',
       error=NULL,
       processed_at=NULL
     WHERE instagram_comment_deliveries.status='failed'
     RETURNING comment_id`,
    [commentId, mediaId, automationId]
  );
  return Boolean(r.rowCount);
}

export async function markInstagramCommentSent(
  commentId: string,
  messageId: string | null
) {
  await pool.query(
    `UPDATE instagram_comment_deliveries
     SET status='sent', message_id=$2, error=NULL, processed_at=NOW()
     WHERE comment_id=$1`,
    [commentId, messageId]
  );
}

export async function markInstagramCommentFailed(
  commentId: string,
  error: string
) {
  await pool.query(
    `UPDATE instagram_comment_deliveries
     SET status='failed', error=$2, processed_at=NOW()
     WHERE comment_id=$1`,
    [commentId, error.slice(0, 1000)]
  );
}

export async function instagramAutomationStats() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM instagram_automations) AS total_rules,
      (SELECT COUNT(*)::int FROM instagram_automations WHERE enabled=TRUE) AS enabled_rules,
      (SELECT COUNT(*)::int FROM instagram_comment_deliveries WHERE status='sent') AS sent,
      (SELECT COUNT(*)::int FROM instagram_comment_deliveries WHERE status='failed') AS failed
  `);
  return {
    totalRules: Number(r.rows[0]?.total_rules ?? 0),
    enabledRules: Number(r.rows[0]?.enabled_rules ?? 0),
    sent: Number(r.rows[0]?.sent ?? 0),
    failed: Number(r.rows[0]?.failed ?? 0)
  };
}
