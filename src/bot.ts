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
  getUserLanguageOrNull,
  grantSubscription,
  isSubscriptionActive,
  rejectPayment,
  revokeSubscription,
  setMarketing,
  setPrice,
  setSetting,
  setUserLanguage
} from "./db.js";
import { c, localeFor, type UserLanguage } from "./i18n.js";
import { formatAdminReport } from "./admin_reports.js";
import { removeAccess, sendAccess } from "./access.js";
import { verifyKaspiReceiptPdf } from "./receipt_verifier.js";
import { registerAdminPanel } from "./admin_panel.js";

function languageKeyboard() {
  return new InlineKeyboard()
    .text("🇷🇺 Русский", "lang:ru")
    .text("🇰🇿 Қазақша", "lang:kk");
}

function mainMenu(lang: UserLanguage) {
  const ui = c(lang);
  return new InlineKeyboard()
    .text(ui.payKz, "menu:pay:kz")
    .row()
    .text(ui.payCis, "menu:pay:cis")
    .row()
    .text(ui.trialButton, "menu:trial")
    .row()
    .text(ui.aboutButton, "menu:about")
    .row()
    .text(ui.faqButton, "menu:faq")
    .row()
    .url(ui.supportButton, supportUrl());
}

function faqMenu(lang: UserLanguage) {
  const ui = c(lang);
  return new InlineKeyboard()
    .text(ui.faqPayment, "faq:payment")
    .row()
    .text(ui.faqAccess, "faq:access")
    .row()
    .text(ui.faqRenewal, "faq:renewal")
    .row()
    .text(ui.faqReceipt, "faq:receipt")
    .row()
    .text(ui.faqCountries, "faq:countries")
    .row()
    .text(ui.faqTrial, "faq:trial")
    .row()
    .text(ui.menuBack, "faq:menu");
}

async function languageOf(userId: number) {
  return getUserLanguage(userId);
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
  const lang = await languageOf(userId);
  const ui = c(lang);
  const price = await getPrice();
  await beginPaymentSession(userId, price);
  const formattedPrice = price.toLocaleString(localeFor(lang));
  const kb = new InlineKeyboard()
    .url(`${ui.kaspiButton} — ${formattedPrice} ₸`, config.KASPI_PAY_URL);

  await bot.api.sendMessage(
    userId,
    formatBlock(ui.paymentText(formattedPrice, config.SUBSCRIPTION_DAYS)),
    { parse_mode: "HTML", reply_markup: kb }
  );
}

async function showCisPayment(bot: Bot, userId: number) {
  const lang = await languageOf(userId);
  const ui = c(lang);
  const kb = new InlineKeyboard().url(
    ui.cisPayButton,
    "https://t.me/tribute/app?startapp=s14Dc"
  );

  await bot.api.sendMessage(
    userId,
    formatBlock(ui.cisPaymentText),
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
    if (size > 10_000_000) throw new Error("Receipt PDF is too large");
    return Buffer.from(await response.arrayBuffer());
  }

  async function processReceiptPdf(userId: number, pdf: Buffer) {
    const lang = await languageOf(userId);
    const ui = c(lang);
    let pending = await getPendingPaymentForUser(userId);
    if (!pending) {
      const price = await getPrice();
      await createPendingPayment(userId, price);
      pending = await getPendingPaymentForUser(userId);
    }
    if (!pending) {
      await bot.api.sendMessage(userId, ui.paymentSessionFailed);
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
      const localized =
        ui.receiptErrors[verification.code as keyof typeof ui.receiptErrors] ??
        verification.message;
      await bot.api.sendMessage(userId, `❌ ${localized.replace(/^❌\s*/, "")}`);
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
        ui.accessNotConfigured
      );
      return;
    }

    const approved = await approvePaymentByVerifiedReceipt(userId, verification.receipt);
    if (!approved.ok) {
      if (approved.reason === "receipt_used") {
        await bot.api.sendMessage(userId, ui.receiptUsed);
        return;
      }
      await bot.api.sendMessage(userId, ui.receiptApplyFailed);
      return;
    }

    await bot.api.sendMessage(userId, ui.receiptApproved);
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
        const lang = await languageOf(userId);
        await ctx.api.sendMessage(userId, c(lang).paidOnly);
      } catch {
        // User may not have started the bot.
      }
    }
  });

  bot.command("start", async ctx => {
    if (!ctx.from) return;
    const saved = await getUserLanguageOrNull(ctx.from.id);
    if (!saved) {
      await ctx.reply(c("ru").chooseLanguage, { reply_markup: languageKeyboard() });
      return;
    }
    await ctx.reply(formatBlock(c(saved).welcome), {
      parse_mode: "HTML",
      reply_markup: mainMenu(saved)
    });
  });

  bot.command("language", async ctx => {
    if (!ctx.from) return;
    await ctx.reply(c(await languageOf(ctx.from.id)).chooseLanguage, {
      reply_markup: languageKeyboard()
    });
  });

  bot.callbackQuery("menu:language", async ctx => {
    const lang = await languageOf(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(c(lang).chooseLanguage, { reply_markup: languageKeyboard() });
  });

  bot.callbackQuery(/^lang:(ru|kk)$/, async ctx => {
    const lang = ctx.match[1] as UserLanguage;
    await setUserLanguage(ctx.from.id, lang);
    const ui = c(lang);
    await ctx.answerCallbackQuery({ text: ui.languageSaved });
    await ctx.reply(formatBlock(ui.welcome), {
      parse_mode: "HTML",
      reply_markup: mainMenu(lang)
    });
  });

  bot.command("menu", async ctx => {
    if (!ctx.from) return;
    const lang = await languageOf(ctx.from.id);
    await ctx.reply(c(lang).menuChoose, { reply_markup: mainMenu(lang) });
  });

  async function sendAbout(userId: number) {
    const lang = await languageOf(userId);
    const ui = c(lang);

    let aboutText: string;
    let contentText: string;
    if (lang === "ru") {
      const legacyAbout = await getSetting("about_text", "");
      const legacyContent = await getSetting("content_text", "");
      aboutText = await getSetting("about_text_ru", legacyAbout || ui.about);
      contentText = await getSetting("content_text_ru", legacyContent || ui.content);
    } else {
      aboutText = await getSetting("about_text_kk", ui.about);
      contentText = await getSetting("content_text_kk", ui.content);
    }

    const text = `${aboutText}\n\n${contentText}`;
    const freeUrl = await getSetting("free_channel_url", config.FREE_CHANNEL_URL ?? "");
    if (freeUrl) {
      await bot.api.sendMessage(userId, formatBlock(text), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url(ui.freeChannelButton, freeUrl)
      });
      return;
    }
    await bot.api.sendMessage(userId, formatBlock(text), { parse_mode: "HTML" });
  }

  async function sendFaq(userId: number) {
    const lang = await languageOf(userId);
    const ui = c(lang);
    await bot.api.sendMessage(userId, ui.faqTitle, {
      reply_markup: faqMenu(lang)
    });
  }

  bot.callbackQuery("menu:faq", async ctx => {
    await ctx.answerCallbackQuery();
    await sendFaq(ctx.from.id);
  });

  bot.callbackQuery("faq:menu", async ctx => {
    const lang = await languageOf(ctx.from.id);
    const ui = c(lang);
    await ctx.answerCallbackQuery();
    await ctx.reply(ui.menuChoose, { reply_markup: mainMenu(lang) });
  });

  bot.callbackQuery(/^faq:(payment|access|renewal|receipt|countries|trial)$/, async ctx => {
    const lang = await languageOf(ctx.from.id);
    const ui = c(lang);
    const key = ctx.match[1];
    const price = await getPrice();
    const formattedPrice = price.toLocaleString(localeFor(lang));

    const answers: Record<string, string> = {
      payment: ui.faqPaymentAnswer(formattedPrice, config.SUBSCRIPTION_DAYS),
      access: ui.faqAccessAnswer,
      renewal: ui.faqRenewalAnswer,
      receipt: ui.faqReceiptAnswer,
      countries: ui.faqCountriesAnswer,
      trial: ui.faqTrialAnswer
    };

    await ctx.answerCallbackQuery();
    await ctx.reply(answers[key] ?? ui.faqTitle, {
      reply_markup: new InlineKeyboard()
        .text(ui.faqBack, "menu:faq")
        .row()
        .text(ui.menuBack, "faq:menu")
    });
  });

  bot.callbackQuery("menu:about", async ctx => {
    await ctx.answerCallbackQuery();
    await sendAbout(ctx.from.id);
  });

  bot.hears(/^(Подробнее о Bakieva Chat|Bakieva Chat туралы толығырақ)$/i, async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  bot.callbackQuery("menu:content", async ctx => {
    await ctx.answerCallbackQuery();
    await sendAbout(ctx.from.id);
  });

  bot.hears(/^(Что есть в чате\?|Чатта не бар\?)$/i, async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  async function sendTrial(userId: number) {
    const lang = await languageOf(userId);
    const ui = c(lang);
    const trialUrl = await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "");
    if (!trialUrl) {
      await bot.api.sendMessage(userId, ui.trialUnavailable);
      return;
    }
    await bot.api.sendMessage(userId, ui.trialReady, {
      reply_markup: new InlineKeyboard().url(ui.trialWatchButton, trialUrl)
    });
  }

  bot.callbackQuery("menu:trial", async ctx => {
    await ctx.answerCallbackQuery();
    await sendTrial(ctx.from.id);
  });

  bot.hears(/^(Посмотреть пробный урок|Сынақ сабағын көру)$/i, async ctx => {
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

  bot.hears(/^(Оплатить подписку|Жазылымды төлеу)$/i, async ctx => {
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
      const lang = await languageOf(ctx.from.id);
      await ctx.answerCallbackQuery({ text: c(lang).openPaymentFirst, show_alert: true });
      return;
    }
    const lang = await languageOf(ctx.from.id);
    const ui = c(lang);
    await ctx.answerCallbackQuery({ text: ui.sendReceiptShort });
    await ctx.reply(
      ui.sendPdfReceipt
    );
  });

  bot.callbackQuery("pay:claim", async ctx => {
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Сначала откройте оплату", show_alert: true });
      return;
    }
    const lang = await languageOf(ctx.from.id);
    const ui = c(lang);
    await ctx.answerCallbackQuery({ text: ui.sendReceiptShort });
    await ctx.reply(ui.sendPdfReceiptShort);
  });

  bot.hears(/https:\/\/receipt\.kaspi\.kz\/\S+/i, async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;
    const lang = await languageOf(ctx.from.id);
    await ctx.reply(c(lang).sendPdfInsteadOfLink);
  });

  bot.on("message:photo", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;
    const lang = await languageOf(ctx.from.id);
    await ctx.reply(c(lang).photoRejected);
  });

  bot.on("message:document", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;

    const document = ctx.message.document;
    const filename = document.file_name?.toLowerCase() ?? "";
    const isPdf = document.mime_type === "application/pdf" || filename.endsWith(".pdf");
    const lang = await languageOf(ctx.from.id);
    const ui = c(lang);
    if (!isPdf) {
      await ctx.reply(ui.pdfOnly);
      return;
    }

    if (document.file_size && document.file_size > 10_000_000) {
      await ctx.reply(ui.pdfTooLarge);
      return;
    }

    await ctx.reply(ui.pdfChecking);
    try {
      const pdf = await downloadTelegramFile(document.file_id);
      await processReceiptPdf(ctx.from.id, pdf);
    } catch (error) {
      console.error("PDF receipt processing failed", { userId: ctx.from.id, error });
      await ctx.reply(ui.pdfFailed);
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
    const lang = await languageOf(userId);
    const ui = c(lang);
    await bot.api.sendMessage(userId, ui.paymentRejected, {
      reply_markup: new InlineKeyboard().url(ui.supportButton, supportUrl())
    });
    await ctx.answerCallbackQuery({ text: "Заявка отклонена" });
    await ctx.editMessageText(`❌ Оплата #${id} отклонена администратором ${ctx.from.id}.`);
  });

  bot.callbackQuery("marketing:off", async ctx => {
    await setMarketing(ctx.from.id, false);
    const lang = await languageOf(ctx.from.id);
    const ui = c(lang);
    await ctx.answerCallbackQuery({ text: ui.marketingDisabled });
    await ctx.reply(ui.marketingOff);
  });

  bot.command("unsubscribe", async ctx => {
    if (!ctx.from) return;
    await setMarketing(ctx.from.id, false);
    await ctx.reply(c(await languageOf(ctx.from.id)).marketingDisabled);
  });

  bot.command("subscribe", async ctx => {
    if (!ctx.from) return;
    await setMarketing(ctx.from.id, true);
    await ctx.reply(c(await languageOf(ctx.from.id)).marketingEnabled);
  });

  bot.command("myid", async ctx => {
    if (!ctx.from) return;
    const ui = c(await languageOf(ctx.from.id));
    await ctx.reply(`${ui.yourId}: ${ctx.from.id}`);
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
