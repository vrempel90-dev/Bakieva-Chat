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

  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [834272]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    for (const file of files) {
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE name=$1", [file]);
      if (applied.rowCount) continue;
      const sql = await readFile(resolve(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [834272]);
    client.release();
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

export type UserLanguage = "ru" | "kk";

export async function getUserLanguage(userId: number): Promise<UserLanguage> {
  const r = await pool.query("SELECT language FROM users WHERE telegram_id=$1", [userId]);
  const value = r.rowCount ? r.rows[0].language : null;
  return value === "kk" ? "kk" : "ru";
}

export async function getUserLanguageOrNull(userId: number): Promise<UserLanguage | null> {
  const r = await pool.query("SELECT language FROM users WHERE telegram_id=$1", [userId]);
  if (!r.rowCount) return null;
  const value = r.rows[0].language;
  return value === "ru" || value === "kk" ? value : null;
}

export async function setUserLanguage(userId: number, language: UserLanguage) {
  await pool.query(
    `INSERT INTO users(telegram_id, language)
     VALUES($1,$2)
     ON CONFLICT(telegram_id) DO UPDATE
     SET language=EXCLUDED.language, updated_at=NOW()`,
    [userId, language]
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query("SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE", [userId]);
    if (!user.rowCount) throw new Error("Payment user must start the bot first");
    const existing = await client.query(
      "SELECT id, requested_at FROM payments WHERE user_id=$1 AND status='pending' FOR UPDATE", [userId]);
    let row = existing.rows[0];
    if (row && new Date(row.requested_at).getTime() < Date.now() - config.KASPI_RECEIPT_MAX_AGE_MINUTES * 60_000) {
      row = (await client.query(`UPDATE payments SET amount=$2, provider='kaspi_receipt',
        requested_at=NOW(), meta='{}'::jsonb WHERE id=$1 RETURNING id, requested_at`, [row.id, amount])).rows[0];
    }
    if (!row) row = (await client.query(`INSERT INTO payments(user_id, provider, amount, status)
      VALUES($1,'kaspi_receipt',$2,'pending') RETURNING id, requested_at`, [userId, amount])).rows[0];
    await client.query("COMMIT");
    return { id: Number(row.id), requestedAt: new Date(row.requested_at) };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function createPendingPayment(userId: number, amount: number) {
  const r = await pool.query(`INSERT INTO payments(user_id, provider, amount, status)
    VALUES($1,'kaspi_link',$2,'pending')
    ON CONFLICT(user_id) WHERE status='pending'
    DO UPDATE SET user_id=EXCLUDED.user_id RETURNING id`, [userId, amount]);
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

    // Same ordering for auto approval, manual approval and access revocation.
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2::text))", [834274, userId]);
    // Serializes competing receipt uploads, including uploads from different users.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [receipt.receiptKey]);
    const existing = await client.query(
      "SELECT id, user_id FROM payments WHERE status='approved' AND meta->>'receipt_key'=$1 LIMIT 1",
      [receipt.receiptKey]
    );
    if (existing.rowCount) {
      const sameUser = Number(existing.rows[0].user_id) === userId;
      const subscription = sameUser ? await client.query(
        "SELECT active_until FROM subscriptions WHERE user_id=$1 AND status='active' AND active_until>NOW()", [userId]
      ) : null;
      await client.query("ROLLBACK");
      if (sameUser && subscription?.rowCount) return {
        ok: true as const, paymentId: Number(existing.rows[0].id),
        activeUntil: new Date(subscription.rows[0].active_until), newlyApproved: false
      };
      return { ok: false as const, reason: "receipt_used" as const };
    }
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

    await client.query(`INSERT INTO access_deliveries(user_id,subscription_until)
      VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET
      subscription_until=EXCLUDED.subscription_until, status='access_pending',
      retryable=TRUE, attempts=0, next_retry_at=NOW(), updated_at=NOW()`,
      [userId, s.rows[0].active_until]);

    await client.query("COMMIT");
    return {
      ok: true as const,
      paymentId: Number(p.rows[0].id),
      activeUntil: new Date(s.rows[0].active_until), newlyApproved: true
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
    const owner = await client.query("SELECT user_id FROM payments WHERE id=$1", [id]);
    if (!owner.rowCount) { await client.query("ROLLBACK"); return null; }
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2::text))", [834274, Number(owner.rows[0].user_id)]);
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
    await client.query(`INSERT INTO access_deliveries(user_id,subscription_until)
      VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET
      subscription_until=EXCLUDED.subscription_until, status='access_pending',
      retryable=TRUE, attempts=0, next_retry_at=NOW(), updated_at=NOW()`,
      [p.rows[0].user_id, s.rows[0].active_until]);
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

export async function publishTrialVideoPair(language: UserLanguage, part1: string, part2: string) {
  if (!part1 || !part2) throw new Error("Both trial parts are required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [key, value] of [
      [`trial_video_file_id_${language}_part1`, part1],
      [`trial_video_file_id_${language}_part2`, part2],
      [`trial_video_file_id_${language}`, ""],
      [`trial_video_pending_${language}_part1`, ""]
    ]) {
      await client.query(`INSERT INTO settings(key,value) VALUES($1,$2)
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [key, value]);
    }
    // Keep historical assets intact; the paired settings take precedence for delivery.
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function getTrialVideoPair(language: UserLanguage) {
  const keys = [`trial_video_file_id_${language}_part1`, `trial_video_file_id_${language}_part2`];
  const result = await pool.query("SELECT key, value FROM settings WHERE key=ANY($1::text[])", [keys]);
  const values = new Map<string, string>(result.rows.map(row => [row.key, row.value]));
  const part1 = values.get(keys[0]) ?? "";
  const part2 = values.get(keys[1]) ?? "";
  return part1 && part2 ? { part1, part2 } : null;
}

export type AiChefHistoryMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
};

export async function getAiChefConversation(
  chatId: number,
  threadId: number,
  userId: number,
  limit = 8,
  maxAgeMinutes = 30
): Promise<AiChefHistoryMessage[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
  const safeAge = Math.max(1, Math.min(24 * 60, Math.trunc(maxAgeMinutes)));
  const r = await pool.query(
    `SELECT role, content, created_at
     FROM ai_chef_messages
     WHERE chat_id=$1
       AND thread_id=$2
       AND user_id=$3
       AND created_at >= NOW() - ($4::int * INTERVAL '1 minute')
     ORDER BY created_at DESC
     LIMIT $5`,
    [chatId, threadId, userId, safeAge, safeLimit]
  );

  return r.rows.reverse().map(row => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content),
    createdAt: new Date(row.created_at)
  }));
}

export async function rememberAiChefMessage(input: {
  chatId: number;
  threadId: number;
  userId: number;
  role: "user" | "assistant";
  content: string;
}) {
  const content = input.content.trim().slice(0, 3500);
  if (!content) return;

  await pool.query(
    `INSERT INTO ai_chef_messages(chat_id, thread_id, user_id, role, content)
     VALUES($1,$2,$3,$4,$5)`,
    [input.chatId, input.threadId, input.userId, input.role, content]
  );

  await pool.query(
    `DELETE FROM ai_chef_messages
     WHERE id IN (
       SELECT id
       FROM ai_chef_messages
       WHERE chat_id=$1 AND thread_id=$2 AND user_id=$3
       ORDER BY created_at DESC
       OFFSET 20
     )`,
    [input.chatId, input.threadId, input.userId]
  );
}

export type AiChefKnowledgeItem = {
  id: number;
  language: "all" | "ru" | "kk";
  title: string;
  body: string;
  createdBy: number | null;
  updatedAt: Date;
};

function mapAiChefKnowledge(row: any): AiChefKnowledgeItem {
  return {
    id: Number(row.id),
    language: row.language === "ru" || row.language === "kk" ? row.language : "all",
    title: String(row.title),
    body: String(row.body),
    createdBy: row.created_by == null ? null : Number(row.created_by),
    updatedAt: new Date(row.updated_at)
  };
}

export async function addAiChefKnowledge(input: {
  language?: "all" | "ru" | "kk";
  title: string;
  body: string;
  createdBy?: number | null;
}) {
  const r = await pool.query(
    `INSERT INTO ai_chef_knowledge(language, title, body, created_by)
     VALUES($1,$2,$3,$4)
     RETURNING *`,
    [
      input.language ?? "all",
      input.title.trim().slice(0, 180),
      input.body.trim().slice(0, 12000),
      input.createdBy ?? null
    ]
  );
  return mapAiChefKnowledge(r.rows[0]);
}

export async function listAiChefKnowledge(
  language: "ru" | "kk" = "ru",
  limit = 40
) {
  const safeLimit = Math.max(1, Math.min(80, Math.trunc(limit)));
  const r = await pool.query(
    `SELECT *
     FROM ai_chef_knowledge
     WHERE language IN ('all',$1)
     ORDER BY updated_at DESC, id DESC
     LIMIT $2`,
    [language, safeLimit]
  );
  return r.rows.map(mapAiChefKnowledge);
}

export async function deleteAiChefKnowledge(id: number) {
  const r = await pool.query(
    "DELETE FROM ai_chef_knowledge WHERE id=$1 RETURNING id",
    [id]
  );
  return Boolean(r.rowCount);
}


export async function getPaidChatId() {
  const raw = await getSetting("paid_chat_id", String(config.paidChatId || ""));
  const value = Number(raw);
  return Number.isSafeInteger(value) && value !== 0 ? value : 0;
}

export async function getPaidMainChatId() {
  const raw = await getSetting("paid_main_chat_id", String(config.paidMainChatId || ""));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !value ||
      value === config.talkChatId || value === await getSettingNumber("talk_chat_id") ||
      value === await getSettingNumber("ai_chef_chat_id")) return 0;
  return value;
}

async function getSettingNumber(key: string) {
  const value = Number(await getSetting(key, "0"));
  return Number.isSafeInteger(value) ? value : 0;
}

export async function setPaidMainChatId(chatId: number) {
  if (!Number.isSafeInteger(chatId) || !chatId ||
      chatId === config.talkChatId || chatId === await getSettingNumber("talk_chat_id") ||
      chatId === await getSettingNumber("ai_chef_chat_id")) {
    throw new Error("Main paid chat cannot be the talk chat");
  }
  await setSetting("paid_main_chat_id", String(chatId));
}

export async function getActiveSubscription(userId: number) {
  const r = await pool.query(
    "SELECT active_until FROM subscriptions WHERE user_id=$1 AND status='active' AND active_until>NOW()",
    [userId]
  );
  return r.rowCount ? new Date(r.rows[0].active_until) : null;
}

export async function dueAccessDeliveries(limit = 20) {
  const r = await pool.query(`SELECT a.user_id, s.active_until FROM access_deliveries a
    JOIN subscriptions s ON s.user_id=a.user_id
    WHERE a.status <> 'access_delivered' AND a.retryable AND a.attempts<5 AND a.next_retry_at<=NOW()
      AND s.status='active' AND s.active_until>NOW()
    ORDER BY a.next_retry_at LIMIT $1`, [limit]);
  return r.rows.map(x => ({ userId: Number(x.user_id), activeUntil: new Date(x.active_until) }));
}

export async function getPaidChannelId() {
  const raw = await getSetting("paid_channel_id", String(config.paidChannelId || ""));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !value ||
      value === config.talkChatId || value === await getSettingNumber("talk_chat_id") ||
      value === await getSettingNumber("ai_chef_chat_id")) return 0;
  return value;
}

export async function setPaidChatId(chatId: number) {
  await setSetting("paid_chat_id", String(chatId));
}

export async function setPaidChannelId(chatId: number) {
  if (!Number.isSafeInteger(chatId) || !chatId ||
      chatId === config.talkChatId || chatId === await getSettingNumber("talk_chat_id") ||
      chatId === await getSettingNumber("ai_chef_chat_id")) {
    throw new Error("Paid channel cannot be the talk chat");
  }
  await setSetting("paid_channel_id", String(chatId));
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


export const LEGACY_COHORT = "2026-10-12";
export const LEGACY_EXPIRES_AT = new Date("2026-10-12T23:59:59+05:00");

export async function registerLegacyMember(userId: number) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO legacy_members(user_id, cohort, expires_at)
       VALUES($1,$2,$3)
       ON CONFLICT(user_id) DO UPDATE SET
         cohort=EXCLUDED.cohort,
         expires_at=EXCLUDED.expires_at`,
      [userId, LEGACY_COHORT, LEGACY_EXPIRES_AT]
    );

    const r = await client.query(
      `INSERT INTO subscriptions(user_id,status,active_until)
       VALUES($1,'active',$2)
       ON CONFLICT(user_id) DO UPDATE SET
         status='active',
         active_until=GREATEST(subscriptions.active_until, EXCLUDED.active_until),
         last_reminder_at=NULL,
         updated_at=NOW()
       RETURNING active_until`,
      [userId, LEGACY_EXPIRES_AT]
    );

    await client.query("COMMIT");
    return new Date(r.rows[0].active_until);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerLegacyMembers(userIds: number[]) {
  const unique = [...new Set(userIds.filter(id => Number.isInteger(id) && id > 0))];
  let registered = 0;
  for (const userId of unique) {
    await pool.query(
      "INSERT INTO users(telegram_id) VALUES($1) ON CONFLICT(telegram_id) DO NOTHING",
      [userId]
    );
    await registerLegacyMember(userId);
    registered++;
  }
  return { requested: unique.length, registered };
}

export async function legacyStats() {
  const r = await pool.query(
    `SELECT
       COUNT(*)::int AS registered,
       COUNT(*) FILTER (
         WHERE s.status='active' AND s.active_until > $2
       )::int AS renewed
     FROM legacy_members l
     LEFT JOIN subscriptions s ON s.user_id=l.user_id
     WHERE l.cohort=$1`,
    [LEGACY_COHORT, LEGACY_EXPIRES_AT]
  );

  return {
    registered: Number(r.rows[0]?.registered ?? 0),
    renewed: Number(r.rows[0]?.renewed ?? 0)
  };
}

export async function getLegacyMembers() {
  const r = await pool.query(
    `SELECT user_id FROM legacy_members
     WHERE cohort=$1
     ORDER BY registered_at ASC`,
    [LEGACY_COHORT]
  );
  return r.rows.map(x => Number(x.user_id));
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1,hashtext($2::text))", [834274, userId]);
    const r = await client.query(
    `INSERT INTO subscriptions(user_id,status,active_until)
     VALUES($1,'active',NOW() + ($2 * interval '1 day'))
     ON CONFLICT(user_id) DO UPDATE SET status='active',
       active_until=GREATEST(subscriptions.active_until,NOW()) + ($2 || ' days')::interval,
       last_reminder_at=NULL, updated_at=NOW()
     RETURNING active_until`,
    [userId, days]
    );
    await client.query(`INSERT INTO access_deliveries(user_id,subscription_until)
      VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET
      subscription_until=EXCLUDED.subscription_until, status='access_pending',
      retryable=TRUE, attempts=0, next_retry_at=NOW(), updated_at=NOW()`,
      [userId, r.rows[0].active_until]);
    await client.query("COMMIT");
    return new Date(r.rows[0].active_until);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
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
    `SELECT s.user_id, s.active_until
     FROM subscriptions s
     WHERE s.status='active'
       AND s.active_until > NOW()
       AND s.active_until <= NOW() + interval '3 days'
       AND s.last_reminder_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM legacy_members l
         WHERE l.user_id=s.user_id AND l.cohort=$1
       )`,
    [LEGACY_COHORT]
  );
  return r.rows.map(x => ({ userId:Number(x.user_id), activeUntil:new Date(x.active_until) }));
}

export async function markReminded(userId: number) {
  await pool.query("UPDATE subscriptions SET last_reminder_at=NOW() WHERE user_id=$1", [userId]);
}

export async function expiredSubscriptions() {
  const r = await pool.query(
    `SELECT s.user_id
     FROM subscriptions s
     WHERE s.status='active'
       AND s.active_until<=NOW()
       AND NOT EXISTS (
         SELECT 1 FROM legacy_members l
         WHERE l.user_id=s.user_id AND l.cohort=$1
       )`,
    [LEGACY_COHORT]
  );
  return r.rows.map(x => Number(x.user_id));
}

export async function markExpired(userId: number) {
  await pool.query("UPDATE subscriptions SET status='expired', updated_at=NOW() WHERE user_id=$1 AND status='active' AND active_until<=NOW()", [userId]);
}


export async function getTrialVideoAsset(language: UserLanguage) {
  const r = await pool.query(
    "SELECT content, mime_type, telegram_file_id FROM trial_video_assets WHERE language=$1",
    [language]
  );
  if (!r.rowCount) return null;
  return {
    content: r.rows[0].content as Buffer | null,
    mimeType: String(r.rows[0].mime_type ?? "video/mp4"),
    telegramFileId: r.rows[0].telegram_file_id ? String(r.rows[0].telegram_file_id) : null
  };
}

export async function upsertTrialVideoContent(language: UserLanguage, content: Buffer, mimeType = "video/mp4") {
  await pool.query(
    `INSERT INTO trial_video_assets(language, content, mime_type, telegram_file_id, updated_at)
     VALUES($1,$2,$3,NULL,NOW())
     ON CONFLICT(language) DO UPDATE SET
       content=EXCLUDED.content,
       mime_type=EXCLUDED.mime_type,
       telegram_file_id=NULL,
       updated_at=NOW()`,
    [language, content, mimeType]
  );
}

export async function setTrialVideoTelegramFileId(language: UserLanguage, fileId: string) {
  await pool.query(
    `INSERT INTO trial_video_assets(language, telegram_file_id, updated_at)
     VALUES($1,$2,NOW())
     ON CONFLICT(language) DO UPDATE SET
       telegram_file_id=EXCLUDED.telegram_file_id,
       updated_at=NOW()`,
    [language, fileId]
  );
}

export async function clearTrialVideoAsset(language: UserLanguage) {
  await pool.query("DELETE FROM trial_video_assets WHERE language=$1", [language]);
}


export async function getTrialPdfAsset(language: UserLanguage) {
  const r = await pool.query(
    "SELECT content, mime_type, filename, telegram_file_id FROM trial_pdf_assets WHERE language=$1",
    [language]
  );
  if (!r.rowCount) return null;
  return {
    content: r.rows[0].content as Buffer | null,
    mimeType: String(r.rows[0].mime_type ?? "application/pdf"),
    filename: String(r.rows[0].filename),
    telegramFileId: r.rows[0].telegram_file_id ? String(r.rows[0].telegram_file_id) : null
  };
}

export async function upsertTrialPdfContent(
  language: UserLanguage,
  content: Buffer,
  filename: string,
  mimeType = "application/pdf"
) {
  await pool.query(
    `INSERT INTO trial_pdf_assets(language, content, mime_type, filename, telegram_file_id, updated_at)
     VALUES($1,$2,$3,$4,NULL,NOW())
     ON CONFLICT(language) DO UPDATE SET
       content=EXCLUDED.content,
       mime_type=EXCLUDED.mime_type,
       filename=EXCLUDED.filename,
       telegram_file_id=NULL,
       updated_at=NOW()`,
    [language, content, mimeType, filename]
  );
}

export async function setTrialPdfTelegramFileId(language: UserLanguage, fileId: string) {
  await pool.query(
    `UPDATE trial_pdf_assets
     SET telegram_file_id=$2, updated_at=NOW()
     WHERE language=$1`,
    [language, fileId]
  );
}


export async function rememberCurrentChatMember(
  chatId: number,
  userId: number,
  source: "message" | "chat_member" | "join_request" | "manual" = "message"
) {
  await pool.query(
    `INSERT INTO current_chat_members(
       chat_id, user_id, is_active, first_seen_at, last_seen_at, left_at, source
     ) VALUES($1,$2,TRUE,NOW(),NOW(),NULL,$3)
     ON CONFLICT(chat_id,user_id) DO UPDATE SET
       is_active=TRUE,
       last_seen_at=NOW(),
       left_at=NULL,
       source=EXCLUDED.source`,
    [chatId, userId, source]
  );
}

export async function forgetCurrentChatMember(chatId: number, userId: number) {
  await pool.query(
    `UPDATE current_chat_members
     SET is_active=FALSE, left_at=NOW(), last_seen_at=NOW()
     WHERE chat_id=$1 AND user_id=$2`,
    [chatId, userId]
  );
}

export async function getCurrentChatMemberIds(chatId: number) {
  const r = await pool.query(
    `SELECT user_id
     FROM current_chat_members
     WHERE chat_id=$1 AND is_active=TRUE
     ORDER BY first_seen_at ASC`,
    [chatId]
  );
  return r.rows.map(x => Number(x.user_id));
}

export async function currentChatMemberStats(chatId: number) {
  const r = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active=TRUE)::int AS active,
       COUNT(*)::int AS seen
     FROM current_chat_members
     WHERE chat_id=$1`,
    [chatId]
  );
  return {
    active: Number(r.rows[0]?.active ?? 0),
    seen: Number(r.rows[0]?.seen ?? 0)
  };
}
