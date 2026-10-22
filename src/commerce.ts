import { UserError } from "./errors.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { pool } from "./db.js";
import { config, DATA_CONSENT_VERSION } from "./config.js";
import { withUserLock } from "./transaction.js";
import { normalizePhone } from "./phone.js";

export type Plan = { id: string; name: string; price: number; days: number };
export async function seedPlans() {
  await pool.query(
    `INSERT INTO plans(id,name,price,days) VALUES
    ('month','1 месяц',COALESCE((SELECT value::integer FROM settings WHERE key='price'),$1),$2),
    ('half_year','6 месяцев',$3,$4) ON CONFLICT DO NOTHING`,
    [
      config.SUBSCRIPTION_PRICE,
      config.SUBSCRIPTION_DAYS,
      config.HALF_YEAR_PRICE,
      config.HALF_YEAR_DAYS,
    ],
  );
}
export async function getPlans(): Promise<Plan[]> {
  return (await pool.query("SELECT * FROM plans ORDER BY days,id")).rows;
}
export async function updatePlan(id: string, price: number, days?: number) {
  if (
    !["month", "half_year"].includes(id) ||
    !Number.isInteger(price) ||
    price < 1 ||
    price > 100000000 ||
    (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650))
  )
    throw new UserError("Неверные параметры тарифа");
  await pool.query(
    "UPDATE plans SET price=$2,days=COALESCE($3,days),updated_at=NOW() WHERE id=$1",
    [id, price, days ?? null],
  );
}
export async function selectPlan(
  userId: number,
  planId: string,
  updateId: number,
) {
  return withUserLock(userId, async (c) => {
    // Retain the original purchase ID across Telegram redelivery, even after approval.
    const replay = await c.query(
      "SELECT * FROM payments WHERE meta->>'selection_update_id'=$1 AND user_id=$2",
      [String(updateId), userId],
    );
    if (replay.rowCount) return replay.rows[0];
    const pending = await c.query(
      "SELECT * FROM payments WHERE user_id=$1 AND status='pending'",
      [userId],
    );
    if (pending.rowCount) return pending.rows[0];
    const p = await c.query("SELECT * FROM plans WHERE id=$1", [planId]);
    if (!p.rowCount) throw new UserError("Тариф не найден");
    const plan = p.rows[0];
    const result = await c.query(
      `INSERT INTO payments
      (user_id,provider,amount,status,plan_id,plan_name,plan_days,buyer_name,buyer_username,
       whatsapp,whatsapp_provided_at,data_consent_at,data_consent_version,marketing_opt_in,marketing_consented_at,meta)
      SELECT telegram_id,'kaspi_link',$2,'pending',$3,$4,$5,first_name,username,
        whatsapp,whatsapp_provided_at,data_consent_at,data_consent_version,marketing_opt_in,marketing_consented_at,$6::jsonb
      FROM users WHERE telegram_id=$1 RETURNING *`,
      [
        userId,
        plan.price,
        plan.id,
        plan.name,
        plan.days,
        JSON.stringify({ selection_update_id: String(updateId) }),
      ],
    );
    return result.rows[0];
  });
}
export async function claimPayment(userId: number, id: number) {
  return withUserLock(userId, async (c) => {
    const r = await c.query(
      `UPDATE payments SET claimed_at=COALESCE(claimed_at,NOW())
      WHERE id=$1 AND user_id=$2 AND status='pending' AND NOT legacy RETURNING *`,
      [id, userId],
    );
    return r.rows[0] ?? null;
  });
}
export async function cancelPayment(userId: number, id: number) {
  return withUserLock(userId, async (c) => {
    const r = await c.query(
      `UPDATE payments SET status='rejected'
      WHERE id=$1 AND user_id=$2 AND status='pending' AND claimed_at IS NULL RETURNING id`,
      [id, userId],
    );
    return Boolean(r.rowCount);
  });
}

async function activate(c: pg.PoolClient, userId: number) {
  const u = (
    await c.query("SELECT * FROM users WHERE telegram_id=$1", [userId])
  ).rows[0];
  if (
    !u?.whatsapp ||
    !u.whatsapp_provided_at ||
    !u.data_consent_at ||
    !u.data_consent_version
  )
    return;
  const purchases = await c.query(
    `SELECT * FROM payments WHERE user_id=$1 AND status='approved'
    AND activated_at IS NULL AND NOT legacy AND access_status='waiting_profile' ORDER BY approved_at,id FOR UPDATE`,
    [userId],
  );
  for (const p of purchases.rows) {
    const sub = await c.query(
      `INSERT INTO subscriptions(user_id,status,active_until)
      VALUES($1,'active',NOW()+$2*interval '1 day') ON CONFLICT(user_id) DO UPDATE SET
      status='active', active_until=(CASE WHEN subscriptions.status='active'
        THEN GREATEST(subscriptions.active_until,NOW()) ELSE NOW() END)+$2*interval '1 day',
      last_reminder_at=NULL,access_removed_at=NULL,updated_at=NOW() RETURNING active_until`,
      [userId, p.plan_days],
    );
    await c.query(
      `UPDATE payments SET activated_at=NOW(),subscription_end=$2,
      subscription_start=$2::timestamptz-$3*interval '1 day',access_status='ready',
      whatsapp=$4,whatsapp_provided_at=$5,data_consent_at=$6,data_consent_version=$7,
      marketing_opt_in=$8,marketing_consented_at=$9 WHERE id=$1`,
      [
        p.id,
        sub.rows[0].active_until,
        p.plan_days,
        u.whatsapp,
        u.whatsapp_provided_at,
        u.data_consent_at,
        u.data_consent_version,
        u.marketing_opt_in,
        u.marketing_consented_at,
      ],
    );
  }
}
export async function approvePayment(id: number, adminId: number) {
  if (!config.adminIds.has(adminId)) throw new UserError("Нет доступа");
  const p = (await pool.query("SELECT user_id FROM payments WHERE id=$1", [id]))
    .rows[0];
  if (!p?.user_id) return null;
  return withUserLock(Number(p.user_id), async (c) => {
    const payment = (
      await c.query("SELECT * FROM payments WHERE id=$1 FOR UPDATE", [id])
    ).rows[0];
    if (!payment || payment.status !== "pending") return null;
    if (payment.legacy)
      throw new UserError(
        "Архивная заявка: сначала /payment_plan ID month|half_year",
      );
    if (!payment.claimed_at)
      throw new UserError("Клиент ещё не заявил об оплате");
    await c.query(
      `UPDATE payments SET status='approved',approved_at=NOW(),approved_by=$2,
      access_status='waiting_profile' WHERE id=$1`,
      [id, adminId],
    );
    await activate(c, Number(p.user_id));
    return { userId: Number(p.user_id) };
  });
}
export async function rejectPayment(id: number, adminId: number) {
  if (!config.adminIds.has(adminId)) throw new UserError("Нет доступа");
  const p = (await pool.query("SELECT user_id FROM payments WHERE id=$1", [id]))
    .rows[0];
  if (!p) return null;
  return withUserLock(Number(p.user_id), async (c) => {
    const r = await c.query(
      `UPDATE payments SET status='rejected',approved_by=$2
      WHERE id=$1 AND status='pending' RETURNING user_id`,
      [id, adminId],
    );
    return r.rowCount ? Number(r.rows[0].user_id) : null;
  });
}
export async function assignLegacyPlan(id: number, planId: string) {
  const p = (await pool.query("SELECT user_id FROM payments WHERE id=$1", [id]))
    .rows[0];
  if (!p) throw new UserError("Заявка не найдена");
  return withUserLock(Number(p.user_id), async (c) => {
    const r = await c.query(
      `UPDATE payments SET plan_id=plans.id,plan_name=plans.name,plan_days=plans.days,legacy=FALSE
      FROM plans WHERE payments.id=$1 AND plans.id=$2 AND payments.status='pending' AND payments.legacy RETURNING payments.id`,
      [id, planId],
    );
    if (!r.rowCount)
      throw new UserError(
        "Нужна ожидающая архивная заявка и существующий тариф",
      );
  });
}
export async function profile(userId: number) {
  return (
    await pool.query(
      `SELECT u.*, EXISTS(SELECT 1 FROM payments WHERE user_id=u.telegram_id AND status='approved') AS paid
    FROM users u WHERE telegram_id=$1`,
      [userId],
    )
  ).rows[0];
}
export async function acceptDataConsent(userId: number) {
  return withUserLock(userId, async (c) => {
    await c.query(
      `UPDATE users SET data_consent_at=NOW(),data_consent_version=$2,
      profile_state=CASE WHEN whatsapp IS NULL THEN 'awaiting_phone' ELSE 'idle' END WHERE telegram_id=$1`,
      [userId, DATA_CONSENT_VERSION],
    );
    await activate(c, userId);
  });
}
export async function requestPhone(userId: number) {
  await pool.query(
    "UPDATE users SET profile_state='awaiting_phone',phone_candidate=NULL,phone_token=NULL WHERE telegram_id=$1",
    [userId],
  );
}
export async function proposePhone(
  userId: number,
  input: string,
  contactUserId?: number,
  isContact = false,
) {
  if (isContact && contactUserId !== userId)
    throw new UserError(
      "Поделитесь собственным контактом или введите свой номер вручную",
    );
  const phone = normalizePhone(input);
  if (!phone)
    throw new UserError(
      "Некорректный номер. Пример: +7 701 123 45 67; для других стран укажите + и код страны",
    );
  return withUserLock(userId, async (c) => {
    const token = randomUUID().slice(0, 12);
    const r = await c.query(
      `UPDATE users SET phone_candidate=$2,phone_token=$3,profile_state='confirm_phone'
      WHERE telegram_id=$1 AND data_consent_at IS NOT NULL AND profile_state IN ('awaiting_phone','confirm_phone') RETURNING telegram_id`,
      [userId, phone, token],
    );
    if (!r.rowCount)
      throw new UserError(
        "Сначала откройте /whatsapp и подтвердите обработку данных",
      );
    return { phone, token };
  });
}
export async function confirmPhone(userId: number, token: string) {
  return withUserLock(userId, async (c) => {
    const r = await c.query(
      `UPDATE users SET whatsapp=phone_candidate,whatsapp_provided_at=NOW(),
      phone_candidate=NULL,phone_token=NULL,profile_state='idle' WHERE telegram_id=$1 AND phone_token=$2
      AND phone_candidate IS NOT NULL AND profile_state='confirm_phone' RETURNING whatsapp`,
      [userId, token],
    );
    if (!r.rowCount) return false;
    await activate(c, userId);
    return true;
  });
}
export async function resumePurchase(userId: number) {
  await withUserLock(userId, (c) => activate(c, userId));
}

export async function eligible(
  c: Pick<pg.PoolClient, "query">,
  userId: number,
): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM users u JOIN subscriptions s ON s.user_id=u.telegram_id
    WHERE u.telegram_id=$1 AND u.whatsapp IS NOT NULL AND u.whatsapp_provided_at IS NOT NULL
    AND u.data_consent_at IS NOT NULL AND u.data_consent_version IS NOT NULL
    AND s.status='active' AND s.active_until>clock_timestamp()
    AND EXISTS(SELECT 1 FROM payments p WHERE p.user_id=u.telegram_id AND p.status='approved'
      AND p.plan_id IS NOT NULL AND (p.activated_at IS NOT NULL OR p.legacy))`,
    [userId],
  );
  return Boolean(r.rowCount);
}
export async function grantSubscription(
  userId: number,
  days: number,
  adminId: number,
  updateId: number,
) {
  if (
    !config.adminIds.has(adminId) ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 3650
  )
    throw new UserError("Неверные параметры");
  return withUserLock(userId, async (c) => {
    const validProfile = await c.query(
      `SELECT 1 FROM users u WHERE telegram_id=$1 AND whatsapp IS NOT NULL
      AND whatsapp_provided_at IS NOT NULL AND data_consent_at IS NOT NULL AND data_consent_version IS NOT NULL
      AND EXISTS(SELECT 1 FROM payments WHERE user_id=$1 AND status='approved' AND plan_id IS NOT NULL AND (activated_at IS NOT NULL OR legacy))`,
      [userId],
    );
    if (!validProfile.rowCount)
      throw new UserError(
        "Сначала подтверждённая оплата, WhatsApp и согласие. Команда не заменяет оплату",
      );
    const claim = await c.query(
      `INSERT INTO admin_actions(update_id,admin_id,action,user_id)
      VALUES($1,$2,'extend',$3) ON CONFLICT DO NOTHING RETURNING update_id`,
      [updateId, adminId, userId],
    );
    if (claim.rowCount) {
      await c.query(
        `INSERT INTO subscriptions(user_id,status,active_until)
      VALUES($1,'active',NOW()+$2*interval '1 day') ON CONFLICT(user_id) DO UPDATE SET
      status='active',active_until=(CASE WHEN subscriptions.status='active' THEN GREATEST(subscriptions.active_until,NOW()) ELSE NOW() END)+$2*interval '1 day',
      last_reminder_at=NULL,access_removed_at=NULL,updated_at=NOW()`,
        [userId, days],
      );
      await c.query(
        `UPDATE payments SET access_status='ready' WHERE id=(SELECT id FROM payments
        WHERE user_id=$1 AND status='approved' AND (activated_at IS NOT NULL OR legacy) ORDER BY id DESC LIMIT 1)`,
        [userId],
      );
    }
    return new Date(
      (
        await c.query(
          "SELECT active_until FROM subscriptions WHERE user_id=$1",
          [userId],
        )
      ).rows[0].active_until,
    );
  });
}
export async function revokeSubscription(userId: number) {
  return withUserLock(userId, async (c) => {
    await c.query(
      "UPDATE subscriptions SET status='revoked',active_until=LEAST(active_until,NOW()),access_removed_at=NULL,updated_at=NOW() WHERE user_id=$1",
      [userId],
    );
    await c.query(
      "UPDATE payments SET access_status='revoked' WHERE user_id=$1 AND status='approved'",
      [userId],
    );
  });
}
