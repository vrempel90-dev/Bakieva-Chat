import type { Bot } from "grammy";
import { Keyboard } from "grammy";
import { config } from "./config.js";
import { getActiveSubscription, getUserLanguage, pool } from "./db.js";
import { normalizeWhatsAppPhone } from "./whatsapp_phone.js";

async function awaitingWhatsApp(userId: number): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM user_whatsapp_contacts WHERE user_id=$1 AND phone IS NULL",
    [userId]
  );
  return Boolean(result.rowCount);
}

/** Collect a contact only after the subscription is confirmed; never hold up paid access. */
export async function promptForWhatsApp(bot: Bot, userId: number): Promise<void> {
  if (!await getActiveSubscription(userId)) return;
  const row = await pool.query(
    `INSERT INTO user_whatsapp_contacts(user_id,requested_at)
     VALUES($1,NOW())
     ON CONFLICT(user_id) DO UPDATE SET requested_at=NOW(), updated_at=NOW()
     WHERE user_whatsapp_contacts.phone IS NULL
     RETURNING user_id`,
    [userId]
  );
  if (!row.rowCount) return; // Do not ask a returning subscriber for a number already saved.
  const lang = await getUserLanguage(userId);
  const text = lang === "ru"
    ? "📱 Оплата подтверждена. Напишите номер телефона, на котором у вас работает WhatsApp, в международном формате, например +77001234567. Если WhatsApp привязан к вашему Telegram-номеру, можно нажать кнопку ниже. Номер сохраняется для связи по подписке; не отправляйте чужие контакты."
    : "📱 Төлем расталды. WhatsApp қолданатын телефон нөміріңізді халықаралық форматта жазыңыз, мысалы +77001234567. Егер WhatsApp Telegram нөміріңізге қосылған болса, төмендегі батырманы басыңыз. Нөмір жазылым жөніндегі байланыс үшін сақталады.";
  const keyboard = new Keyboard()
    .requestContact(lang === "ru" ? "📱 Поделиться моим номером" : "📱 Нөмірімді бөлісу")
    .resized().oneTime();
  await bot.api.sendMessage(userId, text, { reply_markup: keyboard });
  console.info(JSON.stringify({ event: "whatsapp_request_sent", userId }));
}


/**
 * Catch up paid members who activated their subscription before phone collection
 * existed. A placeholder is created by promptForWhatsApp, so each user is selected
 * only once and no repeated reminders are sent on later scheduler ticks.
 */
export async function promptExistingSubscribersForWhatsApp(bot: Bot, batchSize = 25): Promise<void> {
  const candidates = await pool.query(
    `SELECT s.user_id
       FROM subscriptions s
       LEFT JOIN user_whatsapp_contacts w ON w.user_id = s.user_id
      WHERE s.status = 'active'
        AND s.active_until > NOW()
        AND w.user_id IS NULL
      ORDER BY s.user_id
      LIMIT $1`,
    [batchSize]
  );
  let sent = 0;
  let failed = 0;
  for (const row of candidates.rows) {
    const userId = Number(row.user_id);
    try {
      await promptForWhatsApp(bot, userId);
      sent++;
    } catch (error) {
      failed++;
      console.warn("whatsapp_backfill_failed", {
        userId,
        type: error instanceof Error ? error.name : "Error"
      });
    }
  }
  if (sent || failed) {
    console.info(JSON.stringify({
      event: "whatsapp_backfill_batch",
      candidates: candidates.rows.length, sent, failed
    }));
  }
}

async function storeWhatsApp(bot: Bot, userId: number, phone: string): Promise<boolean> {
  const saved = await pool.query(
    `UPDATE user_whatsapp_contacts AS w
     SET phone=$2, received_at=NOW(), updated_at=NOW()
     FROM users AS u
     WHERE w.user_id=$1 AND w.phone IS NULL AND u.telegram_id=w.user_id
     RETURNING u.first_name, u.last_name, u.username`,
    [userId, phone]
  );
  if (!saved.rowCount) return false;
  const profile = saved.rows[0] as {
    first_name: string | null;
    last_name: string | null;
    username: string | null;
  };
  const clean = (value: string | null) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, 128);
  const firstName = clean(profile.first_name);
  const lastName = clean(profile.last_name);
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const username = clean(profile.username);
  const message = [
    "📱 WhatsApp клиента Bakieva Chat",
    `👤 Имя: ${firstName || "не указано"}`,
    `🪪 ФИО (как указано в Telegram): ${fullName || "не указано"}${lastName ? "" : " (фамилия не указана)"}`,
    `🔗 Username: ${username ? "@" + username.replace(/^@/, "") : "нет"}`,
    `🆔 Telegram ID: ${userId}`,
    `📞 WhatsApp: ${phone}`
  ].join("\n");
  // Deliver contact details only to configured admins; do not log personal information.
  for (const adminId of config.adminIds) {
    try {
      await bot.api.sendMessage(adminId, message);
    } catch (error) {
      console.warn("whatsapp_admin_notice_failed", {
        userId, adminId, type: error instanceof Error ? error.name : "Error"
      });
    }
  }
  return true;
}

export function registerWhatsAppHandlers(bot: Bot): void {
  bot.on("message:contact", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        !await awaitingWhatsApp(ctx.from.id)) return next();
    if (ctx.message.contact.user_id !== ctx.from.id) {
      await ctx.reply("Пожалуйста, отправьте свой контакт или введите свой WhatsApp-номер текстом.");
      return;
    }
    const phone = normalizeWhatsAppPhone(ctx.message.contact.phone_number);
    if (!phone) {
      await ctx.reply("Укажите WhatsApp-номер в международном формате, например +77001234567.");
      return;
    }
    if (await storeWhatsApp(bot, ctx.from.id, phone)) {
      await ctx.reply((await getUserLanguage(ctx.from.id)) === "ru"
        ? "✅ WhatsApp-номер сохранён. Ваш оплаченный доступ уже активен."
        : "✅ WhatsApp нөмірі сақталды. Ақылы қолжетімділігіңіз белсенді.",
        { reply_markup: { remove_keyboard: true } });
    }
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.chat.type !== "private" || !ctx.from ||
        ctx.message.text.startsWith("/") || !await awaitingWhatsApp(ctx.from.id)) {
      return next();
    }
    // While awaiting a number, allow unrelated menu choices and ordinary
    // messages to continue through the regular bot handlers.
    if (!/^[+(\d]/.test(ctx.message.text.trim())) return next();
    const phone = normalizeWhatsAppPhone(ctx.message.text);
    if (!phone) {
      await ctx.reply((await getUserLanguage(ctx.from.id)) === "ru"
        ? "Введите номер WhatsApp в международном формате: +77001234567."
        : "WhatsApp нөмірін халықаралық форматта енгізіңіз: +77001234567.");
      return;
    }
    if (await storeWhatsApp(bot, ctx.from.id, phone)) {
      await ctx.reply((await getUserLanguage(ctx.from.id)) === "ru"
        ? "✅ WhatsApp-номер сохранён. Ваш оплаченный доступ уже активен."
        : "✅ WhatsApp нөмірі сақталды. Ақылы қолжетімділігіңіз белсенді.",
        { reply_markup: { remove_keyboard: true } });
    }
  });
}
