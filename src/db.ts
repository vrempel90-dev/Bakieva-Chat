import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
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
  const migrationsDir = resolve(here, "../migrations");
  const files = (await readdir(migrationsDir))
    .filter(name => /^\d+_.+\.sql$/.test(name))
    .sort();

  for (const file of files) {
    const sql = await readFile(resolve(migrationsDir, file), "utf8");
    await pool.query(sql);
  }
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

export async function beginPaymentSession(userId: number, amount: number) {
  const existing = await pool.query(
    "SELECT id, requested_at FROM payments WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1",
    [userId]
  );

  if (existing.rowCount) {
    const requestedAt = new Date(existing.rows[0].requested_at);
    const staleBefore = Date.now() - config.KASPI_RECEIPT_MAX_AGE_MINUTES * 60_000;
    if (requestedAt.getTime() < staleBefore) {
      const refreshed = await pool.query(
        `UPDATE payments
         SET amount=$2, provider='kaspi_receipt', requested_at=NOW(), meta='{}'::jsonb
         WHERE id=$1
         RETURNING id, requested_at`,
        [existing.rows[0].id, amount]
      );
      return {
        id: Number(refreshed.rows[0].id),
        requestedAt: new Date(refreshed.rows[0].requested_at)
      };
    }
    return { id: Number(existing.rows[0].id), requestedAt };
  }

  const created = await pool.query(
    `INSERT INTO payments(user_id, provider, amount, status)
     VALUES($1,'kaspi_receipt',$2,'pending')
     RETURNING id, requested_at`,
    [userId, amount]
  );
  return {
    id: Number(created.rows[0].id),
    requestedAt: new Date(created.rows[0].requested_at)
  };
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

export async function getPendingPaymentForUser(userId: number) {
  const r = await pool.query(
    "SELECT id, amount, requested_at FROM payments WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1",
    [userId]
  );
  if (!r.rowCount) return null;
  return {
    id: Number(r.rows[0].id),
    amount: Number(r.rows[0].amount),
    requestedAt: new Date(r.rows[0].requested_at)
  };
}

export async function approvePaymentByVerifiedReceipt(
  userId: number,
  receipt: {
    receiptKey: string;
    url: string;
    amount: number;
    merchantBin: string;
    receiptDate: Date | null;
  }
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const p = await client.query(
      "SELECT * FROM payments WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1 FOR UPDATE",
      [userId]
    );
    if (!p.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "no_pending" as const };
    }

    if (Number(p.rows[0].amount) !== receipt.amount) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "amount_mismatch" as const };
    }

    const duplicate = await client.query(
      "SELECT id FROM payments WHERE status='approved' AND meta->>'receipt_key'=$1 LIMIT 1",
      [receipt.receiptKey]
    );
    if (duplicate.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false as const, reason: "receipt_used" as const };
    }

    await client.query(
      `UPDATE payments
       SET provider='kaspi_receipt',
           status='approved',
           approved_by=NULL,
           approved_at=NOW(),
           meta = meta || $2::jsonb
       WHERE id=$1`,
      [
        p.rows[0].id,
        JSON.stringify({
          receipt_key: receipt.receiptKey,
          receipt_url: receipt.url,
          merchant_bin: receipt.merchantBin,
          receipt_date: receipt.receiptDate?.toISOString() ?? null,
          verification: "receipt.kaspi.kz"
        })
      ]
    );

    const days = config.SUBSCRIPTION_DAYS;
    const s = await client.query(
      `INSERT INTO subscriptions(user_id,status,active_until)
       VALUES($1,'active',NOW() + ($2 * interval '1 day'))
       ON CONFLICT(user_id) DO UPDATE SET
         status='active',
         active_until=GREATEST(subscriptions.active_until, NOW()) + ($2 * interval '1 day'),
         last_reminder_at=NULL,
         updated_at=NOW()
       RETURNING active_until`,
      [userId, days]
    );

    await client.query("COMMIT");
    return {
      ok: true as const,
      paymentId: Number(p.rows[0].id),
      activeUntil: new Date(s.rows[0].active_until)
    };
  } catch (error: any) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") {
      return { ok: false as const, reason: "receipt_used" as const };
    }
    throw error;
  } finally {
    client.release();
  }
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
       VALUES($1,'active',NOW() + ($2 * interval '1 day'))
       ON CONFLICT(user_id) DO UPDATE SET
         status='active',
         active_until=GREATEST(subscriptions.active_until, NOW()) + ($2 * interval '1 day'),
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

export async function existingUserIds(userIds: number[]) {
  if (userIds.length === 0) return [];
  const r = await pool.query(
    "SELECT telegram_id FROM users WHERE telegram_id = ANY($1::bigint[])",
    [userIds.map(String)]
  );
  return r.rows.map(x => Number(x.telegram_id));
}


export type ContentPost = {
  id: number;
  kind: "video" | "news";
  status: "draft" | "published" | "deleted";
  audience: "all" | "active" | null;
  title: string | null;
  body: string | null;
  telegramFileId: string | null;
  telegramFileUniqueId: string | null;
  createdBy: number;
  createdAt: Date;
  publishedAt: Date | null;
  notifiedCount: number;
};

function mapContentPost(row: any): ContentPost {
  return {
    id: Number(row.id),
    kind: row.kind,
    status: row.status,
    audience: row.audience,
    title: row.title ?? null,
    body: row.body ?? null,
    telegramFileId: row.telegram_file_id ?? null,
    telegramFileUniqueId: row.telegram_file_unique_id ?? null,
    createdBy: Number(row.created_by),
    createdAt: new Date(row.created_at),
    publishedAt: row.published_at ? new Date(row.published_at) : null,
    notifiedCount: Number(row.notified_count ?? 0)
  };
}

export async function createContentDraft(input: {
  kind: "video" | "news";
  title?: string | null;
  body?: string | null;
  telegramFileId?: string | null;
  telegramFileUniqueId?: string | null;
  createdBy: number;
}) {
  const r = await pool.query(
    `INSERT INTO content_posts(
       kind, status, title, body, telegram_file_id, telegram_file_unique_id, created_by
     ) VALUES($1,'draft',$2,$3,$4,$5,$6)
     RETURNING *`,
    [
      input.kind,
      input.title ?? null,
      input.body ?? null,
      input.telegramFileId ?? null,
      input.telegramFileUniqueId ?? null,
      input.createdBy
    ]
  );
  return mapContentPost(r.rows[0]);
}

export async function getContentPost(id: number) {
  const r = await pool.query("SELECT * FROM content_posts WHERE id=$1", [id]);
  return r.rowCount ? mapContentPost(r.rows[0]) : null;
}

export async function publishContentPost(id: number, audience: "all" | "active") {
  const r = await pool.query(
    `UPDATE content_posts
     SET status='published', audience=$2, published_at=COALESCE(published_at,NOW()), deleted_at=NULL
     WHERE id=$1 AND status='draft'
     RETURNING *`,
    [id, audience]
  );
  return r.rowCount ? mapContentPost(r.rows[0]) : null;
}

export async function markContentNotified(id: number, count: number) {
  await pool.query(
    "UPDATE content_posts SET notified_count=$2 WHERE id=$1",
    [id, count]
  );
}

export async function deleteContentPost(id: number) {
  const r = await pool.query(
    `UPDATE content_posts
     SET status='deleted', deleted_at=NOW()
     WHERE id=$1 AND status<>'deleted'
     RETURNING id`,
    [id]
  );
  return Boolean(r.rowCount);
}

export async function listContentPosts(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const r = await pool.query(
    `SELECT * FROM content_posts
     WHERE status<>'deleted'
     ORDER BY created_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return r.rows.map(mapContentPost);
}

export async function listPublishedContent(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const r = await pool.query(
    `SELECT * FROM content_posts
     WHERE status='published'
     ORDER BY published_at DESC NULLS LAST, id DESC
     LIMIT $1`,
    [safeLimit]
  );
  return r.rows.map(mapContentPost);
}

export async function getActiveNotificationUsers() {
  const r = await pool.query(
    `SELECT u.telegram_id
     FROM users u
     JOIN subscriptions s ON s.user_id=u.telegram_id
     WHERE u.marketing_opt_in=TRUE
       AND s.status='active'
       AND s.active_until>NOW()`
  );
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

export type AdminReportStats = {
  newUsers: number;
  payingUsers: number;
  payments: number;
  revenue: number;
  activeSubscriptions: number;
  pendingPayments: number;
};

export async function adminStatsForDays(days: number): Promise<AdminReportStats> {
  const safeDays = Math.max(1, Math.min(365, Math.trunc(days)));
  const r = await pool.query(
    `
    WITH bounds AS (
      SELECT (
        date_trunc('day', NOW() AT TIME ZONE $2)
        - (($1::int - 1) * interval '1 day')
      ) AT TIME ZONE $2 AS since
    )
    SELECT
      (SELECT COUNT(*)::int FROM users, bounds WHERE users.created_at >= bounds.since) AS new_users,
      (SELECT COUNT(DISTINCT user_id)::int FROM payments, bounds
        WHERE status='approved' AND approved_at >= bounds.since) AS paying_users,
      (SELECT COUNT(*)::int FROM payments, bounds
        WHERE status='approved' AND approved_at >= bounds.since) AS payments,
      (SELECT COALESCE(SUM(amount),0)::int FROM payments, bounds
        WHERE status='approved' AND approved_at >= bounds.since) AS revenue,
      (SELECT COUNT(*)::int FROM subscriptions
        WHERE status='active' AND active_until > NOW()) AS active_subscriptions,
      (SELECT COUNT(*)::int FROM payments WHERE status='pending') AS pending_payments
    `,
    [safeDays, config.ADMIN_TIMEZONE]
  );

  return {
    newUsers: Number(r.rows[0].new_users),
    payingUsers: Number(r.rows[0].paying_users),
    payments: Number(r.rows[0].payments),
    revenue: Number(r.rows[0].revenue),
    activeSubscriptions: Number(r.rows[0].active_subscriptions),
    pendingPayments: Number(r.rows[0].pending_payments)
  };
}

export async function grantSubscription(userId: number, days: number) {
  const r = await pool.query(
    `INSERT INTO subscriptions(user_id,status,active_until)
     VALUES($1,'active',NOW() + ($2 * interval '1 day'))
     ON CONFLICT(user_id) DO UPDATE SET status='active',
       active_until=GREATEST(subscriptions.active_until,NOW()) + ($2 || ' days')::interval,
       last_reminder_at=NULL, updated_at=NOW()
     RETURNING active_until`,
    [userId, days]
  );
  return new Date(r.rows[0].active_until);
}

export async function isSubscriptionActive(userId: number) {
  const r = await pool.query(
    "SELECT 1 FROM subscriptions WHERE user_id=$1 AND status='active' AND active_until>NOW()",
    [userId]
  );
  return r.rowCount === 1;
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
       AND last_reminder_at IS NULL`
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
