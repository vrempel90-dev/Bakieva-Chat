import pg from "pg";
import { runMigrations } from "./migrations.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: ["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(config.DATABASE_URL).hostname,
  )
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000,
});

export async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const client = await pool.connect();
  try {
    await runMigrations(client, resolve(here, "../migrations"));
  } finally {
    client.release();
  }
}

export async function ensureUser(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}) {
  await pool.query(
    `INSERT INTO users(telegram_id, username, first_name)
     VALUES($1,$2,$3)
     ON CONFLICT(telegram_id) DO UPDATE
     SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()`,
    [
      user.id,
      user.username ?? null,
      [user.first_name, user.last_name].filter(Boolean).join(" ") || null,
    ],
  );
}

export async function hasConsent(userId: number, version: string) {
  const r = await pool.query(
    "SELECT 1 FROM consents WHERE user_id=$1 AND version=$2",
    [userId, version],
  );
  return r.rowCount === 1;
}

export async function acceptConsent(userId: number, version: string) {
  await pool.query(
    `INSERT INTO consents(user_id, version) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version, accepted_at=NOW()`,
    [userId, version],
  );
}

export async function getPrice() {
  const r = await pool.query("SELECT price FROM plans WHERE id='month'");
  return r.rowCount ? Number(r.rows[0].price) : config.SUBSCRIPTION_PRICE;
}

export async function setPrice(value: number) {
  await pool.query(
    "UPDATE plans SET price=$1,updated_at=NOW() WHERE id='month'",
    [value],
  );
}

export async function getSetting(key: string, fallback = "") {
  const r = await pool.query("SELECT value FROM settings WHERE key=$1", [key]);
  return r.rowCount ? String(r.rows[0].value) : fallback;
}

export async function setSetting(key: string, value: string) {
  await pool.query(
    `INSERT INTO settings(key,value) VALUES($1,$2)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [key, value],
  );
}

export async function setMarketing(userId: number, enabled: boolean) {
  await pool.query(
    `UPDATE users SET marketing_opt_in=$2,
    marketing_consented_at=CASE WHEN $2 THEN NOW() ELSE NULL END,updated_at=NOW() WHERE telegram_id=$1`,
    [userId, enabled],
  );
}

export async function getMarketingUsers() {
  const r = await pool.query(
    "SELECT telegram_id FROM users WHERE marketing_opt_in=TRUE AND marketing_consented_at IS NOT NULL",
  );
  return r.rows.map((x) => Number(x.telegram_id));
}

export async function stats() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM users) users,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status='active' AND active_until>NOW()) active,
      (SELECT COUNT(*)::int FROM payments WHERE status='pending' AND claimed_at IS NOT NULL) pending,
      (SELECT COALESCE(SUM(amount),0)::bigint FROM payments WHERE status='approved') revenue
  `);
  const row = r.rows[0];
  return {
    users: Number(row.users),
    active: Number(row.active),
    pending: Number(row.pending),
    revenue: Number(row.revenue),
  };
}

export async function dueForReminder() {
  const r = await pool.query(
    `SELECT user_id, active_until FROM subscriptions
     WHERE status='active'
       AND active_until > NOW()
       AND active_until <= NOW() + interval '3 days'
       AND (last_reminder_at IS NULL OR last_reminder_at < NOW() - interval '2 days')`,
  );
  return r.rows.map((x) => ({
    userId: Number(x.user_id),
    activeUntil: new Date(x.active_until),
  }));
}

export async function markReminded(userId: number) {
  await pool.query(
    "UPDATE subscriptions SET last_reminder_at=NOW() WHERE user_id=$1",
    [userId],
  );
}

export async function expiredSubscriptions() {
  const r = await pool.query(
    "SELECT user_id FROM subscriptions WHERE (status='active' AND active_until<=NOW()) OR (status='revoked' AND access_removed_at IS NULL)",
  );
  return r.rows.map((x) => Number(x.user_id));
}

export type NewsDelivery = {
  chatId: number;
  title: string;
  username: string | null;
  status: "sent" | "failed";
  messageId: number | null;
  error: string | null;
};

export async function createNewsPublication(
  adminId: number,
  sourceChatId: number,
  sourceMessageId: number,
): Promise<number | null> {
  const result = await pool.query(
    `INSERT INTO news_publications(admin_id, source_chat_id, source_message_id)
     VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [adminId, sourceChatId, sourceMessageId],
  );
  return result.rowCount ? Number(result.rows[0].id) : null;
}

export async function recordNewsDelivery(
  publicationId: number,
  delivery: NewsDelivery,
) {
  await pool.query(
    `INSERT INTO news_deliveries(
       publication_id, target_chat_id, target_title, target_username,
       status, sent_message_id, error_text
     ) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(publication_id, target_chat_id) DO UPDATE SET
       target_title=EXCLUDED.target_title, target_username=EXCLUDED.target_username,
       status=EXCLUDED.status, sent_message_id=EXCLUDED.sent_message_id,
       error_text=EXCLUDED.error_text`,
    [
      publicationId,
      delivery.chatId,
      delivery.title,
      delivery.username,
      delivery.status,
      delivery.messageId,
      delivery.error,
    ],
  );
}

export async function getLatestNewsPublication(adminId: number): Promise<{
  id: number;
  createdAt: Date;
  deliveries: NewsDelivery[];
} | null> {
  const published = await pool.query(
    "SELECT id, created_at FROM news_publications WHERE admin_id=$1 ORDER BY id DESC LIMIT 1",
    [adminId],
  );
  if (!published.rowCount) return null;
  const id = Number(published.rows[0].id);
  const results = await pool.query(
    `SELECT target_chat_id, target_title, target_username, status, sent_message_id, error_text
     FROM news_deliveries WHERE publication_id=$1 ORDER BY target_chat_id`,
    [id],
  );
  return {
    id,
    createdAt: new Date(published.rows[0].created_at),
    deliveries: results.rows.map((row) => ({
      chatId: Number(row.target_chat_id),
      title: String(row.target_title),
      username:
        row.target_username === null ? null : String(row.target_username),
      status: row.status as "sent" | "failed",
      messageId:
        row.sent_message_id === null ? null : Number(row.sent_message_id),
      error: row.error_text === null ? null : String(row.error_text),
    })),
  };
}
