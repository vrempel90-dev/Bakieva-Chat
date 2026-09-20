import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config } from "./config.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 10
});

export async function migrate() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(resolve(here, "../migrations/001_init.sql"), "utf8");
  await pool.query(sql);
}

export async function ensureUser(user: { id: number; username?: string; first_name?: string }) {
  await pool.query(
    `INSERT INTO users(telegram_id, username, first_name)
     VALUES($1,$2,$3)
     ON CONFLICT(telegram_id) DO UPDATE
     SET username=EXCLUDED.username, first_name=EXCLUDED.first_name, updated_at=NOW()`,
    [user.id, user.username ?? null, user.first_name ?? null]
  );
}

export async function hasConsent(userId: number, version: string) {
  const r = await pool.query("SELECT 1 FROM consents WHERE user_id=$1 AND version=$2", [userId, version]);
  return r.rowCount === 1;
}

export async function acceptConsent(userId: number, version: string) {
  await pool.query(
    `INSERT INTO consents(user_id, version) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET version=EXCLUDED.version, accepted_at=NOW()`,
    [userId, version]
  );
}

export async function createPendingPayment(userId: number, amount: number) {
  const existing = await pool.query(
    "SELECT id FROM payments WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  if (existing.rowCount) return Number(existing.rows[0].id);
  const r = await pool.query(
    "INSERT INTO payments(user_id, provider, amount, status) VALUES($1,'kaspi_link',$2,'pending') RETURNING id",
    [userId, amount]
  );
  return Number(r.rows[0].id);
}

export async function getPayment(id: number) {
  const r = await pool.query("SELECT * FROM payments WHERE id=$1", [id]);
  return r.rows[0] ?? null;
}

export async function approvePayment(id: number, adminId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const p = await client.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [id]);
    if (!p.rowCount || p.rows[0].status !== "pending") {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      "UPDATE payments SET status='approved', approved_by=$2, approved_at=NOW() WHERE id=$1",
      [id, adminId]
    );
    const days = config.SUBSCRIPTION_DAYS;
    const s = await client.query(
      `INSERT INTO subscriptions(user_id,status,active_until)
       VALUES($1,'active',NOW() + ($2 || ' days')::interval)
       ON CONFLICT(user_id) DO UPDATE SET
         status='active',
         active_until=GREATEST(subscriptions.active_until, NOW()) + ($2 || ' days')::interval,
         last_reminder_at=NULL,
         updated_at=NOW()
       RETURNING active_until`,
      [p.rows[0].user_id, days]
    );
    await client.query("COMMIT");
    return { userId: Number(p.rows[0].user_id), activeUntil: new Date(s.rows[0].active_until) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function rejectPayment(id: number, adminId: number) {
  const r = await pool.query(
    `UPDATE payments SET status='rejected', approved_by=$2, approved_at=NOW()
     WHERE id=$1 AND status='pending' RETURNING user_id`,
    [id, adminId]
  );
  return r.rowCount ? Number(r.rows[0].user_id) : null;
}

export async function getPrice() {
  const r = await pool.query("SELECT value FROM settings WHERE key='price'");
  return r.rowCount ? Number(r.rows[0].value) : config.SUBSCRIPTION_PRICE;
}

export async function setPrice(value: number) {
  await pool.query(
    `INSERT INTO settings(key,value) VALUES('price',$1)
     ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [String(value)]
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
    [key, value]
  );
}

export async function setMarketing(userId: number, enabled: boolean) {
  await pool.query("UPDATE users SET marketing_opt_in=$2, updated_at=NOW() WHERE telegram_id=$1", [userId, enabled]);
}

export async function getMarketingUsers() {
  const r = await pool.query("SELECT telegram_id FROM users WHERE marketing_opt_in=TRUE");
  return r.rows.map(x => Number(x.telegram_id));
}

export async function stats() {
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM users) users,
      (SELECT COUNT(*)::int FROM subscriptions WHERE status='active' AND active_until>NOW()) active,
      (SELECT COUNT(*)::int FROM payments WHERE status='pending') pending,
      (SELECT COALESCE(SUM(amount),0)::int FROM payments WHERE status='approved') revenue
  `);
  return r.rows[0] as { users:number; active:number; pending:number; revenue:number };
}

export async function grantSubscription(userId: number, days: number) {
  const r = await pool.query(
    `INSERT INTO subscriptions(user_id,status,active_until)
     VALUES($1,'active',NOW() + ($2 || ' days')::interval)
     ON CONFLICT(user_id) DO UPDATE SET status='active',
       active_until=GREATEST(subscriptions.active_until,NOW()) + ($2 || ' days')::interval,
       last_reminder_at=NULL, updated_at=NOW()
     RETURNING active_until`,
    [userId, days]
  );
  return new Date(r.rows[0].active_until);
}

export async function revokeSubscription(userId: number) {
  await pool.query(
    "UPDATE subscriptions SET status='revoked', active_until=LEAST(active_until,NOW()), updated_at=NOW() WHERE user_id=$1",
    [userId]
  );
}

export async function dueForReminder() {
  const r = await pool.query(
    `SELECT user_id, active_until FROM subscriptions
     WHERE status='active'
       AND active_until > NOW()
       AND active_until <= NOW() + interval '3 days'
       AND (last_reminder_at IS NULL OR last_reminder_at < NOW() - interval '2 days')`
  );
  return r.rows.map(x => ({ userId:Number(x.user_id), activeUntil:new Date(x.active_until) }));
}

export async function markReminded(userId: number) {
  await pool.query("UPDATE subscriptions SET last_reminder_at=NOW() WHERE user_id=$1", [userId]);
}

export async function expiredSubscriptions() {
  const r = await pool.query(
    "SELECT user_id FROM subscriptions WHERE status='active' AND active_until<=NOW()"
  );
  return r.rows.map(x => Number(x.user_id));
}

export async function markExpired(userId: number) {
  await pool.query("UPDATE subscriptions SET status='expired', updated_at=NOW() WHERE user_id=$1", [userId]);
}
