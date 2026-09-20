import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  approvePayment,
  approvePaymentByVerifiedReceipt,
  beginPaymentSession,
  createPendingPayment,
  ensureUser,
  getMarketingUsers,
  getPendingPaymentForUser,
  getPrice,
  getSetting,
  grantSubscription,
  isSubscriptionActive,
  rejectPayment,
  revokeSubscription,
  setMarketing,
  setPrice,
  setSetting,
  stats
} from "./db.js";
import { ABOUT, CONTENT, WELCOME } from "./texts.js";
import { removeAccess, sendAccess } from "./access.js";
import {
  extractKaspiReceiptUrl,
  extractKaspiReceiptUrlFromImage,
  verifyKaspiReceipt
} from "./receipt_verifier.js";

function mainMenu() {
  return new InlineKeyboard()
    .text("💳 Оплатить подписку", "menu:pay")
    .row()
    .text("ℹ️ Подробнее о Bakieva Chat", "menu:about")
    .row()
    .text("▶️ Посмотреть пробный урок", "menu:trial")
    .row()
    .url("💬 Поддержка в WhatsApp", supportUrl());
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function formatBlock(text: string) {
  const lines = text.split("\n");
  if (!lines.length) return "";
  const [first, ...rest] = lines;
  const formattedFirst = first ? `<b>${escapeHtml(first)}</b>` : "";
  const formattedRest = rest.map(escapeHtml).join("\n");
  return formattedRest ? `${formattedFirst}\n${formattedRest}` : formattedFirst;
}

function isAdmin(id?: number) {
  return typeof id === "number" && config.adminIds.has(id);
}

function supportUrl() {
  const digits = config.SUPPORT_PHONE.replace(/\D/g, "");
  return `https://wa.me/${digits}`;
}

async function showPayment(bot: Bot, userId: number) {
  const price = await getPrice();
  await beginPaymentSession(userId, price);
  const kb = new InlineKeyboard()
    .url(`💳 Оплатить ${price.toLocaleString("ru-RU")} ₸ через Kaspi`, config.KASPI_PAY_URL)
    .row()
    .text("🔎 Проверить чек", "pay:verify");

  const paymentText = `Стоимость подписки — ${price.toLocaleString("ru-RU")} ₸ на ${config.SUBSCRIPTION_DAYS} дней.\n\n1. Оплатите точную сумму по кнопке ниже.\n2. После оплаты вернитесь в бот и нажмите «Проверить чек».\n3. Отправьте фото фискального чека Kaspi целиком, чтобы был виден QR-код. Бот проверит чек автоматически.`;
  await bot.api.sendMessage(
    userId,
    formatBlock(paymentText),
    { parse_mode: "HTML", reply_markup: kb }
  );
}

export function createBot() {
  const bot = new Bot(config.BOT_TOKEN);

  async function downloadTelegramFile(fileId: string) {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram file path is missing");
    const response = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Telegram file HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? "0");
    if (size > 8_000_000) throw new Error("Receipt image is too large");
    return Buffer.from(await response.arrayBuffer());
  }

  async function processReceiptUrl(userId: number, receiptUrl: string) {
    let pending = await getPendingPaymentForUser(userId);
    if (!pending) {
      const price = await getPrice();
      await createPendingPayment(userId, price);
      pending = await getPendingPaymentForUser(userId);
    }
    if (!pending) {
      await bot.api.sendMessage(userId, "Не удалось создать проверку платежа. Попробуйте ещё раз.");
      return;
    }

    const verification = await verifyKaspiReceipt({
      url: receiptUrl,
      expectedAmount: pending.amount,
      expectedMerchantBin: config.KASPI_MERCHANT_BIN,
      maxAgeMinutes: config.KASPI_RECEIPT_MAX_AGE_MINUTES,
      paymentRequestedAt: pending.requestedAt
    });

    if (!verification.ok) {
      await bot.api.sendMessage(userId, `❌ ${verification.message}`);
      return;
    }

    const paidTargetConfigured = [config.paidChannelId, config.paidChatId]
      .some(id => Number.isFinite(id) && id !== 0);
    if (!paidTargetConfigured) {
      await bot.api.sendMessage(
        userId,
        "✅ Чек подтверждён Kaspi, но выдача доступа в закрытый чат ещё не настроена."
      );
      return;
    }

    const approved = await approvePaymentByVerifiedReceipt(userId, verification.receipt);
    if (!approved.ok) {
      if (approved.reason === "receipt_used") {
        await bot.api.sendMessage(userId, "❌ Этот чек уже использовался для активации подписки.");
        return;
      }
      await bot.api.sendMessage(userId, "Не удалось применить этот чек к текущему платежу.");
      return;
    }

    await bot.api.sendMessage(userId, "✅ Чек подтверждён. Оплата принята автоматически.");
    await sendAccess(bot, userId, approved.activeUntil);
  }

  bot.use(async (ctx, next) => {
    if (ctx.from) await ensureUser(ctx.from);
    await next();
  });

  bot.on("chat_join_request", async ctx => {
    const request = ctx.chatJoinRequest;
    const chatId = request.chat.id;
    if (![config.paidChannelId, config.paidChatId].includes(chatId)) return;

    const userId = request.from.id;
    const allowed = await isSubscriptionActive(userId);
    if (allowed) {
      await ctx.api.approveChatJoinRequest(chatId, userId);
    } else {
      await ctx.api.declineChatJoinRequest(chatId, userId);
      try {
        await ctx.api.sendMessage(userId, "Доступ в Bakieva Chat доступен только при активной оплаченной подписке.");
      } catch {
        // User may not have started the bot.
      }
    }
  });

  bot.command("start", async ctx => {
    await ctx.reply(formatBlock(WELCOME), { parse_mode: "HTML", reply_markup: mainMenu() });
  });

  bot.command("menu", async ctx => {
    await ctx.reply("Выберите нужный раздел:", { reply_markup: mainMenu() });
  });

  async function sendAbout(userId: number) {
    const aboutText = await getSetting("about_text", ABOUT);
    const contentText = await getSetting("content_text", CONTENT);
    const text = `${aboutText}\n\n${contentText}`;
    const freeUrl = await getSetting("free_channel_url", config.FREE_CHANNEL_URL ?? "");
    if (freeUrl) {
      await bot.api.sendMessage(userId, formatBlock(text), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url("🎁 Бесплатный канал", freeUrl)
      });
      return;
    }
    await bot.api.sendMessage(userId, formatBlock(text), { parse_mode: "HTML" });
  }

  bot.callbackQuery("menu:about", async ctx => {
    await ctx.answerCallbackQuery();
    await sendAbout(ctx.from.id);
  });

  bot.hears("Подробнее о Bakieva Chat", async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  bot.callbackQuery("menu:content", async ctx => {
    await ctx.answerCallbackQuery();
    await sendAbout(ctx.from.id);
  });

  bot.hears("Что есть в чате?", async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  async function sendTrial(userId: number) {
    const trialUrl = await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "");
    if (!trialUrl) {
      await bot.api.sendMessage(userId, "Пробный урок пока обновляется. Ссылка появится здесь после публикации.");
      return;
    }
    await bot.api.sendMessage(userId, "Пробный урок доступен по кнопке ниже:", {
      reply_markup: new InlineKeyboard().url("▶️ Смотреть пробный урок", trialUrl)
    });
  }

  bot.callbackQuery("menu:trial", async ctx => {
    await ctx.answerCallbackQuery();
    await sendTrial(ctx.from.id);
  });

  bot.hears("Посмотреть пробный урок", async ctx => {
    if (!ctx.from) return;
    await sendTrial(ctx.from.id);
  });

  bot.callbackQuery("menu:pay", async ctx => {
    await ctx.answerCallbackQuery();
    await showPayment(bot, ctx.from.id);
  });

  bot.hears("Оплатить подписку", async ctx => {
    if (!ctx.from) return;
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("pay:start", async ctx => {
    await ctx.answerCallbackQuery();
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("pay:verify", async ctx => {
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Сначала откройте оплату", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Отправьте чек" });
    await ctx.reply(
      "Отправьте сюда фото или скрин фискального чека Kaspi целиком. QR-код на чеке должен быть хорошо виден. Также можно отправить официальную ссылку receipt.kaspi.kz."
    );
  });

  bot.callbackQuery("pay:claim", async ctx => {
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Сначала откройте оплату", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Отправьте чек" });
    await ctx.reply("Для автоматической проверки отправьте фото фискального чека Kaspi с видимым QR-кодом.");
  });

  bot.hears(/https:\/\/receipt\.kaspi\.kz\/\S+/i, async ctx => {
    if (!ctx.from) return;
    const messageText = ctx.msg?.text;
    if (!messageText) return;
    const receiptUrl = extractKaspiReceiptUrl(messageText);
    if (!receiptUrl) {
      await ctx.reply("Не удалось распознать официальную ссылку на чек Kaspi.");
      return;
    }
    await ctx.reply("🔎 Проверяю чек в Kaspi...");
    await processReceiptUrl(ctx.from.id, receiptUrl);
  });

  bot.on("message:photo", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;

    const photo = ctx.message.photo.at(-1);
    if (!photo) return;

    await ctx.reply("🔎 Считываю QR-код и проверяю чек в Kaspi...");
    try {
      const image = await downloadTelegramFile(photo.file_id);
      const receiptUrl = await extractKaspiReceiptUrlFromImage(image);
      if (!receiptUrl) {
        await ctx.reply("❌ Не удалось считать QR-код. Отправьте чек целиком и без сильного размытия.");
        return;
      }
      await processReceiptUrl(ctx.from.id, receiptUrl);
    } catch {
      await ctx.reply("❌ Не удалось обработать изображение чека. Попробуйте отправить его ещё раз.");
    }
  });

  bot.on("message:document", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;

    const document = ctx.message.document;
    if (!document.mime_type?.startsWith("image/")) {
      await ctx.reply("Отправьте чек как фото или изображение, чтобы бот мог считать QR-код.");
      return;
    }

    await ctx.reply("🔎 Считываю QR-код и проверяю чек в Kaspi...");
    try {
      const image = await downloadTelegramFile(document.file_id);
      const receiptUrl = await extractKaspiReceiptUrlFromImage(image);
      if (!receiptUrl) {
        await ctx.reply("❌ Не удалось считать QR-код. Отправьте изображение чека целиком.");
        return;
      }
      await processReceiptUrl(ctx.from.id, receiptUrl);
    } catch {
      await ctx.reply("❌ Не удалось обработать изображение чека. Попробуйте ещё раз.");
    }
  });

  bot.callbackQuery(/^pay:approve:(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const id = Number(ctx.match[1]);
    const approved = await approvePayment(id, ctx.from.id);
    if (!approved) {
      await ctx.answerCallbackQuery({ text: "Заявка уже обработана", show_alert: true });
      return;
    }
    await sendAccess(bot, approved.userId, approved.activeUntil);
    await ctx.answerCallbackQuery({ text: "Оплата подтверждена" });
    await ctx.editMessageText(`✅ Оплата #${id} подтверждена администратором ${ctx.from.id}.`);
  });

  bot.callbackQuery(/^pay:reject:(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const id = Number(ctx.match[1]);
    const userId = await rejectPayment(id, ctx.from.id);
    if (!userId) {
      await ctx.answerCallbackQuery({ text: "Заявка уже обработана", show_alert: true });
      return;
    }
    await bot.api.sendMessage(userId, "Платёж не найден или сумма не совпала. Если вы оплатили, напишите в службу поддержки.", {
      reply_markup: new InlineKeyboard().url("💬 Служба поддержки", supportUrl())
    });
    await ctx.answerCallbackQuery({ text: "Заявка отклонена" });
    await ctx.editMessageText(`❌ Оплата #${id} отклонена администратором ${ctx.from.id}.`);
  });

  bot.callbackQuery("marketing:off", async ctx => {
    await setMarketing(ctx.from.id, false);
    await ctx.answerCallbackQuery({ text: "Рассылка отключена" });
    await ctx.reply("Вы отписались от информационных и рекламных рассылок.");
  });

  bot.command("unsubscribe", async ctx => {
    if (!ctx.from) return;
    await setMarketing(ctx.from.id, false);
    await ctx.reply("Рассылка отключена.");
  });

  bot.command("subscribe", async ctx => {
    if (!ctx.from) return;
    await setMarketing(ctx.from.id, true);
    await ctx.reply("Рассылка включена.");
  });

  bot.command("admin", async ctx => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const s = await stats();
    await ctx.reply(
      `Админ-панель Bakieva Chat\n\nПользователей: ${s.users}\nАктивных подписок: ${s.active}\nОжидают проверки: ${s.pending}\nПодтверждено оплат: ${s.revenue.toLocaleString("ru-RU")} ₸\n\nКоманды:\n/grant TELEGRAM_ID DAYS\n/extend TELEGRAM_ID DAYS\n/revoke TELEGRAM_ID\n/price 5000\n/set about текст\n/set content текст\n/set trial_url https://...\n/set free_channel_url https://...\n/broadcast текст`
    );
  });

  bot.command(["grant", "extend"], async ctx => {
    if (!ctx.from || !ctx.message || !isAdmin(ctx.from.id)) return;
    const [, rawUserId, rawDays] = ctx.message.text.trim().split(/\s+/);
    const userId = Number(rawUserId);
    const days = Number(rawDays);
    if (!Number.isInteger(userId) || !Number.isInteger(days) || days <= 0) {
      await ctx.reply("Формат: /grant TELEGRAM_ID DAYS");
      return;
    }
    try {
      const until = await grantSubscription(userId, days);
      await sendAccess(bot, userId, until);
      await ctx.reply(`Готово. Доступ ${userId} продлён до ${until.toLocaleDateString("ru-RU")}.`);
    } catch {
      await ctx.reply("Не удалось выдать доступ. Пользователь должен сначала открыть бота и нажать /start.");
    }
  });

  bot.command("revoke", async ctx => {
    if (!ctx.from || !ctx.message || !isAdmin(ctx.from.id)) return;
    const [, rawUserId] = ctx.message.text.trim().split(/\s+/);
    const userId = Number(rawUserId);
    if (!Number.isInteger(userId)) {
      await ctx.reply("Формат: /revoke TELEGRAM_ID");
      return;
    }
    await revokeSubscription(userId);
    await removeAccess(bot, userId);
    await ctx.reply(`Доступ ${userId} отозван.`);
  });

  bot.command("price", async ctx => {
    if (!ctx.from || !ctx.message || !isAdmin(ctx.from.id)) return;
    const [, rawPrice] = ctx.message.text.trim().split(/\s+/);
    const price = Number(rawPrice);
    if (!Number.isInteger(price) || price <= 0) {
      await ctx.reply("Формат: /price 5000");
      return;
    }
    await setPrice(price);
    await ctx.reply(`Новая стоимость: ${price.toLocaleString("ru-RU")} ₸.`);
  });

  bot.command("set", async ctx => {
    if (!ctx.from || !ctx.message || !isAdmin(ctx.from.id)) return;
    const body = ctx.message.text.replace(/^\/set(?:@\w+)?\s*/i, "").trim();
    const firstSpace = body.indexOf(" ");
    if (firstSpace < 1) {
      await ctx.reply("Формат: /set about текст | /set content текст | /set trial_url https://... | /set free_channel_url https://...");
      return;
    }
    const rawKey = body.slice(0, firstSpace).trim();
    const value = body.slice(firstSpace + 1).trim();
    const keys: Record<string, string> = {
      about: "about_text",
      content: "content_text",
      trial_url: "trial_url",
      free_channel_url: "free_channel_url"
    };
    const key = keys[rawKey];
    if (!key || !value) {
      await ctx.reply("Доступные ключи: about, content, trial_url, free_channel_url.");
      return;
    }
    if (rawKey.endsWith("_url")) {
      try {
        new URL(value);
      } catch {
        await ctx.reply("Нужна корректная ссылка, начинающаяся с https://");
        return;
      }
    }
    await setSetting(key, value);
    await ctx.reply(`Настройка ${rawKey} обновлена.`);
  });

  bot.command("broadcast", async ctx => {
    if (!ctx.from || !ctx.message || !isAdmin(ctx.from.id)) return;
    const text = ctx.message.text.replace(/^\/broadcast(?:@\w+)?\s*/i, "").trim();
    if (!text) {
      await ctx.reply("Формат: /broadcast текст рассылки");
      return;
    }
    const users = await getMarketingUsers();
    let sent = 0;
    const kb = new InlineKeyboard().text("Отписаться от рассылки", "marketing:off");
    for (const userId of users) {
      try {
        await bot.api.sendMessage(userId, text, { reply_markup: kb });
        sent++;
      } catch {
        // User may have blocked the bot.
      }
    }
    await ctx.reply(`Рассылка завершена: ${sent}/${users.length}.`);
  });

  bot.catch(err => {
    console.error("Bot error", err.error);
  });

  return bot;
}
