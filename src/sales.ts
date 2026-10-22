import { UserError } from "./errors.js";
import { Bot, GrammyError, InputFile } from "grammy";
import { pool, getSetting } from "./db.js";
import { config } from "./config.js";

export function localDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Almaty",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function shiftDay(day: string, days: number) {
  return new Date(Date.parse(day + "T12:00:00Z") + days * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function validPeriod(start: string, end: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(start) &&
    /^\d{4}-\d{2}-\d{2}$/.test(end) &&
    Number.isFinite(Date.parse(start)) &&
    Number.isFinite(Date.parse(end)) &&
    new Date(start).toISOString().slice(0, 10) === start &&
    new Date(end).toISOString().slice(0, 10) === end &&
    start <= end
  );
}
export function chunks(text: string, size = 3500): string[] {
  const result: string[] = [];
  let part = "";
  for (const line of text.split("\n")) {
    for (let i = 0; i < line.length || i === 0; i += size) {
      const segment = line.slice(i, i + size);
      if (part.length + segment.length + 1 > size) {
        if (part) result.push(part);
        part = "";
      }
      part += segment + "\n";
    }
  }
  if (part.trim()) result.push(part.trimEnd());
  return result;
}
export function csv(rows: unknown[][], rawE164Columns: number[] = []): Buffer {
  const cell = (value: unknown, index: number) => {
    let text =
      value instanceof Date ? value.toISOString() : String(value ?? "");
    if (rawE164Columns.includes(index) && /^\+[1-9]\d{7,14}$/.test(text))
      return '"' + text + '"';
    // Excel executes formulas even in quoted cells. Prefix phone numbers as text too.
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))
      text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  return Buffer.from(
    "\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n",
    "utf8",
  );
}
export type Sale = {
  id: string;
  user_id: string | null;
  buyer_name: string | null;
  buyer_username: string | null;
  whatsapp: string | null;
  plan_id: string;
  plan_name: string;
  plan_days: number | null;
  amount: number;
  requested_at: Date;
  approved_at: Date;
  subscription_start: Date | null;
  subscription_end: Date | null;
  access_status: string;
  subscription_status: string;
  data_consent_at: Date | null;
  marketing_opt_in: boolean;
  marketing_consented_at: Date | null;
};
const saleSelect = `SELECT p.id,p.user_id,p.buyer_name,p.buyer_username,
  COALESCE(p.whatsapp,u.whatsapp) AS whatsapp,p.plan_id,p.plan_name,p.plan_days,p.amount,
  p.requested_at,p.approved_at,p.subscription_start,p.subscription_end,p.access_status,
  COALESCE(p.data_consent_at,u.data_consent_at) AS data_consent_at,p.marketing_opt_in,p.marketing_consented_at,
  CASE WHEN p.access_status='revoked' THEN 'revoked' WHEN p.activated_at IS NULL AND NOT p.legacy THEN 'waiting_profile'
    WHEN p.subscription_end<=NOW() THEN 'expired' ELSE COALESCE(s.status,'unknown') END AS subscription_status
  FROM payments p LEFT JOIN users u ON u.telegram_id=p.user_id LEFT JOIN subscriptions s ON s.user_id=p.user_id`;
export async function salesData(start: string, end: string) {
  if (!validPeriod(start, end))
    throw new UserError("Период: YYYY-MM-DD YYYY-MM-DD");
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await c.query(
      `${saleSelect} WHERE p.status='approved'
      AND p.approved_at>=($1::date::timestamp AT TIME ZONE 'Asia/Almaty')
      AND p.approved_at< (($2::date+1)::timestamp AT TIME ZONE 'Asia/Almaty') ORDER BY p.approved_at,p.id`,
      [start, end],
    );
    const waiting = await c.query(`SELECT
      (SELECT COUNT(*)::int FROM payments WHERE status='pending' AND claimed_at IS NOT NULL) AS pending,
      (SELECT COUNT(DISTINCT p.user_id)::int FROM payments p JOIN users u ON u.telegram_id=p.user_id
       WHERE p.status='approved' AND u.whatsapp IS NULL) AS missing_phone`);
    await c.query("COMMIT");
    return {
      rows: result.rows as Sale[],
      pending: Number(waiting.rows[0].pending),
      missingPhone: Number(waiting.rows[0].missing_phone),
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
function date(value: Date | null) {
  return value
    ? new Date(value).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })
    : "не активирована";
}
export function salesText(
  start: string,
  end: string,
  data: Awaited<ReturnType<typeof salesData>>,
) {
  const { rows } = data;
  const plans = new Map<string, number>();
  for (const p of rows)
    plans.set(p.plan_name, (plans.get(p.plan_name) ?? 0) + 1);
  return [
    `Продажи ${start}${start === end ? "" : " — " + end} (Asia/Almaty)`,
    `Подтверждённых покупок: ${rows.length}; покупателей с известным ID: ${new Set(rows.flatMap((p) => (p.user_id ? [p.user_id] : []))).size}`,
    ...[...plans].map(([name, count]) => `${name}: ${count}`),
    `Подтверждённая выручка: ${rows.reduce((sum, p) => sum + p.amount, 0).toLocaleString("ru-RU")} ₸`,
    `Сейчас ожидают проверки: ${data.pending}; оплатили без WhatsApp: ${data.missingPhone}`,
    "",
    ...(rows.length
      ? rows.map(
          (p) =>
            `#${p.id} ${p.buyer_name ?? "Без имени / обезличено"} ${p.buyer_username ? "@" + p.buyer_username : ""}\nTelegram ID: ${p.user_id ?? "обезличен"}; WhatsApp: ${p.whatsapp ?? "не предоставлен"}\n${p.plan_name}: ${p.amount} ₸; оплата: ${date(p.approved_at)}\nПодписка до: ${p.subscription_end ? date(p.subscription_end) : p.plan_id === "legacy" ? "неизвестно (архив)" : date(null)}; подписка: ${p.subscription_status}; доступ: ${p.access_status}\n`,
        )
      : ["Подтверждённых покупок нет."]),
  ].join("\n");
}
export function salesCsv(rows: Sale[]) {
  return csv([
    [
      "purchase_id",
      "telegram_id",
      "username",
      "name",
      "whatsapp",
      "plan_id",
      "plan",
      "price_kzt",
      "days",
      "requested_at",
      "confirmed_at",
      "subscription_start",
      "subscription_end",
      "payment_status",
      "subscription_status",
      "access_status",
      "data_consent_at",
      "marketing_consent",
      "marketing_consented_at",
    ],
    ...rows.map((p) => [
      p.id,
      p.user_id,
      p.buyer_username,
      p.buyer_name,
      p.whatsapp,
      p.plan_id,
      p.plan_name,
      p.amount,
      p.plan_days,
      p.requested_at,
      p.approved_at,
      p.subscription_start,
      p.subscription_end,
      "approved",
      p.subscription_status,
      p.access_status,
      p.data_consent_at,
      p.marketing_opt_in,
      p.marketing_consented_at,
    ]),
  ]);
}
export async function buyerRegistry(): Promise<Sale[]> {
  return (
    await pool.query(`${saleSelect} WHERE p.status='approved' ORDER BY p.id`)
  ).rows;
}
export async function contactsExport(marketingOnly = false) {
  const r =
    await pool.query(`SELECT DISTINCT ON (u.telegram_id) u.first_name,u.whatsapp,p.plan_name,p.approved_at,
    u.marketing_opt_in AND u.marketing_consented_at IS NOT NULL AS marketing
    FROM users u JOIN payments p ON p.user_id=u.telegram_id AND p.status='approved'
    WHERE u.whatsapp IS NOT NULL ${marketingOnly ? "AND u.marketing_opt_in=TRUE AND u.marketing_consented_at IS NOT NULL" : ""}
    ORDER BY u.telegram_id,p.approved_at DESC,p.id DESC`);
  return csv(
    [
      [
        "name",
        "phone_e164",
        "phone_excel_text",
        "plan",
        "purchase_date",
        "marketing_consent",
      ],
      ...r.rows.map((p) => [
        p.first_name,
        p.whatsapp,
        p.whatsapp,
        p.plan_name,
        p.approved_at,
        p.marketing,
      ]),
    ],
    [1],
  );
}
type ReportPayload =
  { kind: "text"; text: string } | { kind: "csv"; text: string; name: string };
export async function sendSales(
  bot: Bot,
  adminId: number,
  start: string,
  end: string,
) {
  if (!config.adminIds.has(adminId)) throw new UserError("Нет доступа");
  const data = await salesData(start, end);
  for (const part of chunks(salesText(start, end, data)))
    await bot.api.sendMessage(adminId, part);
  await bot.api.sendDocument(
    adminId,
    new InputFile(salesCsv(data.rows), `sales-${start}-${end}.csv`),
  );
}

// Telegram has no idempotency key for sendMessage/sendDocument. Persist each part before
// sending, and stop ambiguous deliveries for explicit admin reconciliation instead of duplicating.
export async function deliverDaily(bot: Bot, adminId: number, day: string) {
  if (!config.adminIds.has(adminId)) return;
  const c = await pool.connect();
  const lock = `sales:${day}:${adminId}`;
  let locked = false;
  try {
    locked = Boolean(
      (
        await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
          lock,
        ])
      ).rows[0].locked,
    );
    if (!locked) return;
    const job = (
      await c.query(
        `INSERT INTO report_deliveries(report_date,admin_id) VALUES($1,$2)
      ON CONFLICT(report_date,admin_id) DO UPDATE SET admin_id=EXCLUDED.admin_id RETURNING *`,
        [day, adminId],
      )
    ).rows[0];
    if (job.status === "sent") return;
    let parts = (
      await c.query(
        "SELECT * FROM report_parts WHERE delivery_id=$1 ORDER BY part",
        [job.id],
      )
    ).rows;
    if (!parts.length) {
      const data = await salesData(day, day);
      const payloads: ReportPayload[] = [
        ...chunks(salesText(day, day, data)).map((text) => ({
          kind: "text" as const,
          text,
        })),
        {
          kind: "csv",
          text: salesCsv(data.rows).toString("utf8"),
          name: `sales-${day}.csv`,
        },
      ];
      await c.query("BEGIN");
      try {
        for (const [index, payload] of payloads.entries())
          await c.query(
            "INSERT INTO report_parts(delivery_id,part,payload) VALUES($1,$2,$3)",
            [job.id, index, JSON.stringify(payload)],
          );
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
      parts = (
        await c.query(
          "SELECT * FROM report_parts WHERE delivery_id=$1 ORDER BY part",
          [job.id],
        )
      ).rows;
    }
    if (parts.some((p) => p.status === "sending" || p.status === "uncertain")) {
      await c.query(
        "UPDATE report_parts SET status='uncertain' WHERE delivery_id=$1 AND status='sending'",
        [job.id],
      );
      await c.query(
        "UPDATE report_deliveries SET status='uncertain' WHERE id=$1",
        [job.id],
      );
      return;
    }
    for (const part of parts.filter((p) => p.status !== "sent")) {
      await c.query(
        "UPDATE report_parts SET status='sending' WHERE delivery_id=$1 AND part=$2",
        [job.id, part.part],
      );
      let messageId: number;
      try {
        const payload = part.payload as ReportPayload;
        const result =
          payload.kind === "text"
            ? await bot.api.sendMessage(adminId, payload.text)
            : await bot.api.sendDocument(
                adminId,
                new InputFile(Buffer.from(payload.text, "utf8"), payload.name),
              );
        messageId = result.message_id;
      } catch (error) {
        const known = error instanceof GrammyError;
        await c.query(
          "UPDATE report_parts SET status=$3 WHERE delivery_id=$1 AND part=$2",
          [job.id, part.part, known ? "pending" : "uncertain"],
        );
        if (!known)
          await c.query(
            "UPDATE report_deliveries SET status='uncertain' WHERE id=$1",
            [job.id],
          );
        console.warn("Daily report delivery needs retry/reconciliation", {
          deliveryId: job.id,
          part: part.part,
          ambiguous: !known,
        });
        return;
      }
      await c.query(
        "UPDATE report_parts SET status='sent',message_id=$3 WHERE delivery_id=$1 AND part=$2",
        [job.id, part.part, messageId],
      );
    }
    await c.query(
      "UPDATE report_deliveries SET status='sent',sent_at=NOW() WHERE id=$1",
      [job.id],
    );
  } finally {
    try {
      if (locked)
        await c.query("SELECT pg_advisory_unlock(hashtext($1))", [lock]);
    } finally {
      c.release();
    }
  }
}
export async function dailyReports(bot: Bot, now = new Date()) {
  const savedTime = await getSetting(
    "sales_report_time",
    config.SALES_REPORT_TIME,
  );
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(savedTime)
    ? savedTime
    : config.SALES_REPORT_TIME;
  const localTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Almaty",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  if (localTime >= time)
    for (const admin of config.adminIds)
      await deliverDaily(bot, admin, shiftDay(localDay(now), -1));
  const pending = await pool.query(
    "SELECT admin_id,to_char(report_date,'YYYY-MM-DD') AS day FROM report_deliveries WHERE status='pending'",
  );
  for (const job of pending.rows)
    await deliverDaily(bot, Number(job.admin_id), job.day);
}
export async function resolveReportPart(
  adminId: number,
  id: number,
  part: number,
  decision: "sent" | "retry",
) {
  if (!config.adminIds.has(adminId)) throw new UserError("Нет доступа");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const job = (
      await c.query(
        "SELECT admin_id,to_char(report_date,'YYYY-MM-DD') AS day FROM report_deliveries WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!job) {
      await c.query("ROLLBACK");
      return false;
    }
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `sales:${job.day}:${job.admin_id}`,
    ]);
    const r = await c.query(
      `UPDATE report_parts SET status=$3 WHERE delivery_id=$1 AND part=$2 AND status='uncertain' RETURNING delivery_id`,
      [id, part, decision === "sent" ? "sent" : "pending"],
    );
    if (r.rowCount)
      await c.query(
        "UPDATE report_deliveries SET status='pending' WHERE id=$1",
        [id],
      );
    await c.query("COMMIT");
    return Boolean(r.rowCount);
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
