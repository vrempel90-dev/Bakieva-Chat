import { Bot, InlineKeyboard, Keyboard } from "grammy";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { pool, activateDeferredProfilePurchases, setMarketing } from "./db.js";
import { sendAccess } from "./access.js";

// Structural E.164 validation; this is NOT a proof that a WhatsApp account exists.
export function normalizeBuyerPhone(raw: string): string | null {
  const text = raw.trim().replace(/[\s()\-]/g, "");
  const value = text.startsWith("00") ? `+${text.slice(2)}` :
    text.startsWith("8") && text.length === 11 ? `+7${text.slice(1)}` :
    text.startsWith("7") && text.length === 11 ? `+${text}` : text;
  return /^\+[1-9]\d{7,14}$/.test(value) ? value : null;
}

export async function needsBuyerProfile(userId: number): Promise<boolean> {
  const r = await pool.query(`
    SELECT 1 FROM payments p
    WHERE p.user_id=$1 AND p.status='approved'
      AND p.meta->>'whatsapp_required'='true'
      AND NOT EXISTS (
        SELECT 1 FROM buyer_profiles b
        WHERE b.user_id=p.user_id
          AND b.whatsapp_e164 IS NOT NULL AND b.data_consent_at IS NOT NULL
      )
    LIMIT 1`, [userId]);
  return Boolean(r.rowCount);
}

export async function promptBuyerPhone(bot: Bot, userId: number): Promise<boolean> {
  if (!await needsBuyerProfile(userId)) return false;
  await pool.query(`INSERT INTO buyer_profiles(user_id,awaiting_phone)
    VALUES($1,TRUE) ON CONFLICT(user_id) DO UPDATE SET
      awaiting_phone=TRUE,pending_token=NULL,pending_whatsapp_e164=NULL`,[userId]);
  await bot.api.sendMessage(userId,
    "✅ Оплата подтверждена. Для выдачи приглашения укажите WhatsApp в международном формате (+7...). " +
    "Бот не проверяет регистрацию номера в WhatsApp. После ввода потребуется подтверждение согласия на обработку данных.",
    { reply_markup: new Keyboard().requestContact("📱 Поделиться своим номером").row().text("Ввести номер вручную").resized() }
  );
  return true;
}

async function stagePhone(userId: number, raw: string): Promise<{value:string;token:string}|null> {
  const value = normalizeBuyerPhone(raw);
  if (!value) return null;
  const token=randomUUID();
  await pool.query(`INSERT INTO buyer_profiles(user_id,pending_whatsapp_e164,pending_token,awaiting_phone)
    VALUES($1,$2,$3,FALSE) ON CONFLICT(user_id) DO UPDATE SET
    pending_whatsapp_e164=EXCLUDED.pending_whatsapp_e164,
    pending_token=EXCLUDED.pending_token,awaiting_phone=FALSE,updated_at=NOW()`, [userId,value,token]);
  return {value,token};
}

export function installBuyerProfileHandlers(bot: Bot) {
  bot.command("whatsapp", async ctx => {
    if (!ctx.from || ctx.chat.type !== "private") return;
    await pool.query(`INSERT INTO buyer_profiles(user_id,awaiting_phone)
      VALUES($1,TRUE) ON CONFLICT(user_id) DO UPDATE SET
      awaiting_phone=TRUE,pending_token=NULL,pending_whatsapp_e164=NULL`,[ctx.from.id]);
    await ctx.reply("Укажите WhatsApp номер в международном формате (+7...). Вы можете исправить его позднее.",
      { reply_markup: new Keyboard().requestContact("📱 Поделиться своим номером").resized() });
  });

  bot.on("message:contact", async (ctx,next) => {
    if (ctx.chat.type !== "private" || !ctx.from) return next();
    const pending=await pool.query("SELECT awaiting_phone FROM buyer_profiles WHERE user_id=$1",[ctx.from.id]);
    if(!pending.rows[0]?.awaiting_phone && !await needsBuyerProfile(ctx.from.id)) return next();
    // Telegram can prove only that a shared Telegram contact is the sender's contact.
    if (ctx.message.contact.user_id !== ctx.from.id) {
      await ctx.reply("Пришлите свой контакт, а не контакт другого человека."); return;
    }
    const value = await stagePhone(ctx.from.id,ctx.message.contact.phone_number);
    if (!value) { await ctx.reply("Неверный формат номера. Попробуйте +77001234567."); return; }
    await ctx.reply(`Проверьте номер: ${value.value}. Вы даёте согласие хранить и обрабатывать этот номер для сопровождения подписки. Политика ниже.`,
      { reply_markup: new InlineKeyboard()
        .url("🔐 Политика данных",config.PRIVACY_URL)
        .row().text("✅ Подтверждаю и соглашаюсь","buyer:confirm:"+value.token)
        .row().text("✏️ Исправить номер","buyer:correct") });
  });

  bot.on("message:text", async (ctx,next) => {
    if (ctx.chat.type !== "private" || !ctx.from || ctx.message.text.startsWith("/")) return next();
    const pending=await pool.query("SELECT awaiting_phone FROM buyer_profiles WHERE user_id=$1",[ctx.from.id]);
    if (!(await needsBuyerProfile(ctx.from.id)) && !pending.rows[0]?.awaiting_phone) return next();
    if (ctx.message.text === "Ввести номер вручную") {
      await ctx.reply("Введите номер WhatsApp в международном формате, например +77001234567.");
      return;
    }
    const value = await stagePhone(ctx.from.id,ctx.message.text);
    if (!value) {
      await ctx.reply("Неверный номер. Введите международный номер, начинающийся с +.");
      return;
    }
    await ctx.reply(`Проверьте номер: ${value.value}. Вы даёте согласие хранить и обрабатывать этот номер для сопровождения подписки. Политика ниже.`,
      { reply_markup: new InlineKeyboard()
        .url("🔐 Политика данных",config.PRIVACY_URL)
        .row().text("✅ Подтверждаю и соглашаюсь","buyer:confirm:"+value.token)
        .row().text("✏️ Исправить", "buyer:correct") });
  });

  bot.callbackQuery("buyer:correct", async ctx => {
    await ctx.answerCallbackQuery();
    await pool.query("UPDATE buyer_profiles SET pending_whatsapp_e164=NULL,pending_token=NULL,awaiting_phone=TRUE WHERE user_id=$1",[ctx.from.id]);
    await ctx.reply("Пришлите правильный номер WhatsApp в формате +77001234567.");
  });

  bot.callbackQuery(/^buyer:confirm:([0-9a-f-]{36})$/, async ctx => {
    await ctx.answerCallbackQuery();
    const r = await pool.query(`UPDATE buyer_profiles SET
      whatsapp_e164=pending_whatsapp_e164, pending_whatsapp_e164=NULL,pending_token=NULL,
      whatsapp_confirmed_at=NOW(),data_consent_at=NOW(),data_consent_version='2026-10-22-v1',
      awaiting_phone=FALSE,updated_at=NOW()
      WHERE user_id=$1 AND pending_whatsapp_e164 IS NOT NULL AND pending_token=$2
      RETURNING whatsapp_e164`,[ctx.from.id,ctx.match[1]]);
    if (!r.rowCount) { await ctx.reply("Сначала укажите номер."); return; }
    await ctx.reply("✅ Номер сохранён. Хотите отдельно разрешить маркетинговые сообщения?",
      { reply_markup: new InlineKeyboard().text("Разрешаю рассылки", "buyer:marketing:yes")
        .row().text("Не разрешаю", "buyer:marketing:no") });
    await activateDeferredProfilePurchases(ctx.from.id);
    const sub = await pool.query(`SELECT active_until FROM subscriptions
      WHERE user_id=$1 AND status='active' AND active_until>NOW()`,[ctx.from.id]);
    if (sub.rowCount) {
      try { await sendAccess(bot,ctx.from.id,new Date(sub.rows[0].active_until)); }
      catch (error) { console.error("buyer_access_delivery_error", {userId:ctx.from.id,errorType:error instanceof Error?error.name:"unknown"}); }
    }
  });

  bot.callbackQuery(/^buyer:marketing:(yes|no)$/, async ctx => {
    const enabled = ctx.match[1] === "yes";
    await setMarketing(ctx.from.id,enabled);
    await ctx.answerCallbackQuery({text:enabled?"Согласие на рассылки сохранено":"Рассылки отключены"});
    await ctx.reply(enabled?"Вы подписались на маркетинговые сообщения. Отказаться можно через /unsubscribe.":"Маркетинговые сообщения не будут отправляться.");
  });
}
