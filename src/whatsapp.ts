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
}

async function storeWhatsApp(bot: Bot, userId: number, phone: string): Promise<boolean> {
  const saved = await pool.query(
    `UPDATE user_whatsapp_contacts
     SET phone=$2, received_at=NOW(), updated_at=NOW()
     WHERE user_id=$1 AND phone IS NULL RETURNING user_id`,
    [userId, phone]
  );
  if (!saved.rowCount) return false;
  // Deliver contact details only to configured admins; do not log personal information.
  for (const adminId of config.adminIds) {
    try {
      await bot.api.sendMessage(adminId,
        `📱 WhatsApp клиента Bakieva Chat\nTelegram ID: ${userId}\nТелефон: ${phone}`);
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
