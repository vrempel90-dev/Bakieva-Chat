import { Bot, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminStatsForDays,
  approvePayment,
  approvePaymentByVerifiedReceipt,
  beginPaymentSession,
  createPendingPayment,
  ensureUser,
  getMarketingUsers,
  getPendingPaymentForUser,
  getPrice,
  getSetting,
  getPaidChannelId,
  getPaidChatId,
  getUserLanguage,
  grantSubscription,
  isSubscriptionActive,
  rejectPayment,
  revokeSubscription,
  setMarketing,
  setPrice,
  setSetting,
  setUserLanguage
} from "./db.js";
import { formatAdminReport } from "./admin_reports.js";
import { removeAccess, sendAccess } from "./access.js";
import { verifyKaspiReceiptPdf } from "./receipt_verifier.js";
import { registerAdminPanel } from "./admin_panel.js";
import { TEXTS, type Locale } from "./i18n.js";

function languageKeyboard() {
  return new InlineKeyboard()
    .text("🇷🇺 Русский", "lang:ru")
    .text("🇰🇿 Қазақша", "lang:kk");
}

function mainMenu(language: Locale) {
  const t = TEXTS[language];
  return new InlineKeyboard()
    .text(t.payKz, "menu:pay:kz")
    .row()
    .text(t.aboutButton, "menu:about")
    .row()
    .text(t.payCis, "menu:pay:cis")
    .row()
    .text(t.trialButton, "menu:trial")
    .row()
    .url(t.support, supportUrl())
    .row()
    .text(t.languageButton, "menu:language");
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

function adminReportKeyboard() {
  return new InlineKeyboard()
    .text("📊 Сегодня", "admin:stats:1")
    .text("📅 7 дней", "admin:stats:7")
    .row()
    .text("🗓 30 дней", "admin:stats:30")
    .text("🔄 Обновить", "admin:stats:1");
}

function adminPeriodLabel(days: number) {
  if (days === 1) return "сегодня";
  if (days === 7) return "за 7 дней";
  return "за 30 дней";
}

async function showPayment(bot: Bot, userId: number) {
  const language = (await getUserLanguage(userId)) ?? "ru";
  const t = TEXTS[language];
  const price = await getPrice();
  await beginPaymentSession(userId, price);
  const formattedPrice = price.toLocaleString(language === "kk" ? "kk-KZ" : "ru-RU");
  const kb = new InlineKeyboard()
    .url(t.kaspiPayButton(formattedPrice), config.KASPI_PAY_URL);

  await bot.api.sendMessage(
    userId,
    formatBlock(t.kzPayment(formattedPrice, config.SUBSCRIPTION_DAYS)),
    { parse_mode: "HTML", reply_markup: kb }
  );
}

async function showCisPayment(bot: Bot, userId: number) {
  const language = (await getUserLanguage(userId)) ?? "ru";
  const t = TEXTS[language];
  const kb = new InlineKeyboard().url(
    t.cisPayButton,
    "https://t.me/tribute/app?startapp=s14Dc"
  );

  await bot.api.sendMessage(
    userId,
    formatBlock(t.cisPayment),
    { parse_mode: "HTML", reply_markup: kb }
  );
}


export function createBot() {
  const bot = new Bot(config.BOT_TOKEN);

  async function localeFor(userId: number): Promise<Locale> {
    return (await getUserLanguage(userId)) ?? "ru";
  }

  async function sendWelcome(userId: number, language: Locale) {
    const t = TEXTS[language];
    await bot.api.sendMessage(userId, formatBlock(t.welcome), {
      parse_mode: "HTML",
      reply_markup: mainMenu(language)
    });
  }

  async function downloadTelegramFile(fileId: string) {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram file path is missing");
    const response = await fetch(`https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`Telegram file HTTP ${response.status}`);
    const size = Number(response.headers.get("content-length") ?? "0");
    if (size > 10_000_000) throw new Error("Receipt PDF is too large");
    return Buffer.from(await response.arrayBuffer());
  }

  async function processReceiptPdf(userId: number, pdf: Buffer) {
    const language = await localeFor(userId);
    const t = TEXTS[language];
    let pending = await getPendingPaymentForUser(userId);
    if (!pending) {
      const price = await getPrice();
      await createPendingPayment(userId, price);
      pending = await getPendingPaymentForUser(userId);
    }
    if (!pending) {
      await bot.api.sendMessage(userId, t.paymentSetupFailed);
      return;
    }

    const verification = await verifyKaspiReceiptPdf({
      buffer: pdf,
      expectedAmount: pending.amount,
      expectedMerchantBin: config.KASPI_MERCHANT_BIN,
      maxAgeMinutes: config.KASPI_RECEIPT_MAX_AGE_MINUTES,
      paymentRequestedAt: pending.requestedAt
    });

    if (!verification.ok) {
      const message = t.receiptErrors[verification.code] ?? verification.message;
      await bot.api.sendMessage(userId, `❌ ${message}`);
      return;
    }

    const [paidChannelId, paidChatId] = await Promise.all([
      getPaidChannelId(),
      getPaidChatId()
    ]);
    const paidTargetsConfigured = Boolean(paidChannelId && paidChatId);
    if (!paidTargetsConfigured) {
      await bot.api.sendMessage(
        userId,
        t.paidTargetsMissing
      );
      return;
    }

    const approved = await approvePaymentByVerifiedReceipt(userId, verification.receipt);
    if (!approved.ok) {
      if (approved.reason === "receipt_used") {
        await bot.api.sendMessage(userId, t.receiptUsed);
        return;
      }
      await bot.api.sendMessage(userId, t.receiptApplyFailed);
      return;
    }

    await bot.api.sendMessage(userId, t.receiptApproved);
    await sendAccess(bot, userId, approved.activeUntil);
  }

  bot.use(async (ctx, next) => {
    if (ctx.from) await ensureUser(ctx.from);
    await next();
  });

  registerAdminPanel(bot);

  bot.on("chat_join_request", async ctx => {
    const request = ctx.chatJoinRequest;
    const chatId = request.chat.id;
    const [paidChannelId, paidChatId] = await Promise.all([
      getPaidChannelId(),
      getPaidChatId()
    ]);
    if (![paidChannelId, paidChatId].includes(chatId)) return;

    const userId = request.from.id;
    const allowed = await isSubscriptionActive(userId);
    if (allowed) {
      await ctx.api.approveChatJoinRequest(chatId, userId);
    } else {
      await ctx.api.declineChatJoinRequest(chatId, userId);
      try {
        const language = await localeFor(userId);
        await ctx.api.sendMessage(userId, TEXTS[language].joinDenied);
      } catch {
        // User may not have started the bot.
      }
    }
  });

  bot.command("start", async ctx => {
    const stored = await getUserLanguage(ctx.from.id);
    if (!stored) {
      await ctx.reply(TEXTS.ru.chooseLanguage, { reply_markup: languageKeyboard() });
      return;
    }
    await sendWelcome(ctx.from.id, stored);
  });

  bot.command("language", async ctx => {
    await ctx.reply(TEXTS.ru.chooseLanguage, { reply_markup: languageKeyboard() });
  });

  bot.callbackQuery(/^lang:(ru|kk)$/, async ctx => {
    const language = ctx.match[1] as Locale;
    await setUserLanguage(ctx.from.id, language);
    await ctx.answerCallbackQuery({ text: TEXTS[language].languageSaved });
    await sendWelcome(ctx.from.id, language);
  });

  bot.callbackQuery("menu:language", async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply(TEXTS.ru.chooseLanguage, { reply_markup: languageKeyboard() });
  });

  bot.command("menu", async ctx => {
    const language = await localeFor(ctx.from.id);
    await ctx.reply(TEXTS[language].menuPrompt, { reply_markup: mainMenu(language) });
  });


  async function sendAbout(userId: number) {
    const language = await localeFor(userId);
    const t = TEXTS[language];
    const aboutText = language === "ru"
      ? await getSetting("about_text_ru", await getSetting("about_text", t.about))
      : await getSetting("about_text_kk", t.about);
    const contentText = language === "ru"
      ? await getSetting("content_text_ru", await getSetting("content_text", t.content))
      : await getSetting("content_text_kk", t.content);
    const text = `${aboutText}\n\n${contentText}`;
    const freeUrl = await getSetting("free_channel_url", config.FREE_CHANNEL_URL ?? "");
    if (freeUrl) {
      await bot.api.sendMessage(userId, formatBlock(text), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url(t.freeChannel, freeUrl)
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
    const language = await localeFor(userId);
    const t = TEXTS[language];
    const trialUrl = await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "");
    if (!trialUrl) {
      await bot.api.sendMessage(userId, t.trialUnavailable);
      return;
    }
    await bot.api.sendMessage(userId, t.trialAvailable, {
      reply_markup: new InlineKeyboard().url(t.trialWatch, trialUrl)
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

  bot.callbackQuery("menu:pay:kz", async ctx => {
    await ctx.answerCallbackQuery();
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("menu:pay:cis", async ctx => {
    await ctx.answerCallbackQuery();
    await showCisPayment(bot, ctx.from.id);
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
    const language = await localeFor(ctx.from.id);
    const t = TEXTS[language];
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: t.needPaymentFirst, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: t.sendReceipt });
    await ctx.reply(t.sendPdfReceipt);
  });

  bot.callbackQuery("pay:claim", async ctx => {
    const language = await localeFor(ctx.from.id);
    const t = TEXTS[language];
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: t.needPaymentFirst, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: t.sendReceipt });
    await ctx.reply(t.sendPdfReceiptShort);
  });

  bot.hears(/https:\/\/receipt\.kaspi\.kz\/\S+/i, async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;
    const language = await localeFor(ctx.from.id);
    await ctx.reply(TEXTS[language].sendPdfInsteadLink);
  });

  bot.on("message:photo", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;
    const language = await localeFor(ctx.from.id);
    await ctx.reply(TEXTS[language].noPhotos);
  });

  bot.on("message:document", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;

    const language = await localeFor(ctx.from.id);
    const t = TEXTS[language];
    const document = ctx.message.document;
    const filename = document.file_name?.toLowerCase() ?? "";
    const isPdf = document.mime_type === "application/pdf" || filename.endsWith(".pdf");
    if (!isPdf) {
      await ctx.reply(t.pdfOnly);
      return;
    }

    if (document.file_size && document.file_size > 10_000_000) {
      await ctx.reply(t.pdfTooLarge);
      return;
    }

    await ctx.reply(t.readingPdf);
    try {
      const pdf = await downloadTelegramFile(document.file_id);
      await processReceiptPdf(ctx.from.id, pdf);
    } catch (error) {
      console.error("PDF receipt processing failed", { userId: ctx.from.id, error });
      await ctx.reply(t.pdfFailed);
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
    const language = await localeFor(ctx.from.id);
    const t = TEXTS[language];
    await setMarketing(ctx.from.id, false);
    await ctx.answerCallbackQuery({ text: t.marketingOffShort });
    await ctx.reply(t.marketingOff);
  });

  bot.command("unsubscribe", async ctx => {
    if (!ctx.from) return;
    const language = await localeFor(ctx.from.id);
    await setMarketing(ctx.from.id, false);
    await ctx.reply(TEXTS[language].marketingOffShort);
  });

  bot.command("subscribe", async ctx => {
    if (!ctx.from) return;
    const language = await localeFor(ctx.from.id);
    await setMarketing(ctx.from.id, true);
    await ctx.reply(TEXTS[language].marketingOn);
  });

  bot.command("myid", async ctx => {
    if (!ctx.from) return;
    await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}`);
  });

  async function sendAdminStats(
    userId: number,
    days: 1 | 7 | 30,
    edit?: (text: string, options: any) => Promise<unknown>
  ) {
    const s = await adminStatsForDays(days);
    const text = formatAdminReport(s, adminPeriodLabel(days));
    const options = { parse_mode: "HTML" as const, reply_markup: adminReportKeyboard() };
    if (edit) {
      await edit(text, options);
      return;
    }
    await bot.api.sendMessage(userId, text, options);
  }

  bot.command("admin", async ctx => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await sendAdminStats(ctx.from.id, 1);
  });

  bot.callbackQuery(/^admin:stats:(1|7|30)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }

    const days = Number(ctx.match[1]) as 1 | 7 | 30;
    await ctx.answerCallbackQuery();
    await sendAdminStats(
      ctx.from.id,
      days,
      (text, options) => ctx.editMessageText(text, options)
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
      await ctx.reply("Формат: /set about текст | /set about_kk мәтін | /set content текст | /set content_kk мәтін | /set trial_url https://... | /set free_channel_url https://...");
      return;
    }
    const rawKey = body.slice(0, firstSpace).trim();
    const value = body.slice(firstSpace + 1).trim();
    const keys: Record<string, string> = {
      about: "about_text_ru",
      about_kk: "about_text_kk",
      content: "content_text_ru",
      content_kk: "content_text_kk",
      trial_url: "trial_url",
      free_channel_url: "free_channel_url"
    };
    const key = keys[rawKey];
    if (!key || !value) {
      await ctx.reply("Доступные ключи: about, about_kk, content, content_kk, trial_url, free_channel_url.");
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
    for (const userId of users) {
      try {
        const language = await localeFor(userId);
        const kb = new InlineKeyboard().text(TEXTS[language].unsubscribe, "marketing:off");
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
