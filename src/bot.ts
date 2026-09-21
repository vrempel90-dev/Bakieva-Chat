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
  getUserLanguageOrDefault,
  grantSubscription,
  isSubscriptionActive,
  rejectPayment,
  revokeSubscription,
  setMarketing,
  setPrice,
  setSetting,
  setUserLanguage
} from "./db.js";
import type { UserLanguage } from "./db.js";
import { formatDate, t } from "./i18n.js";
import { formatAdminReport } from "./admin_reports.js";
import { removeAccess, sendAccess } from "./access.js";
import { verifyKaspiReceiptPdf } from "./receipt_verifier.js";
import { registerAdminPanel } from "./admin_panel.js";

function languageKeyboard(context: "start" | "change" = "start") {
  return new InlineKeyboard()
    .text("🇷🇺 Русский", `lang:ru:${context}`)
    .text("🇰🇿 Қазақша", `lang:kk:${context}`);
}

function mainMenu(language: UserLanguage) {
  const tr = t(language);
  return new InlineKeyboard()
    .text(tr.menuPayKz, "menu:pay:kz")
    .row()
    .text(tr.menuAbout, "menu:about")
    .row()
    .text(tr.menuPayCis, "menu:pay:cis")
    .row()
    .text(tr.menuTrial, "menu:trial")
    .row()
    .text(tr.menuLanguage, "menu:language")
    .row()
    .url(tr.menuSupport, supportUrl());
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
  const language = await getUserLanguageOrDefault(userId);
  const tr = t(language);
  const price = await getPrice();
  await beginPaymentSession(userId, price);
  const kb = new InlineKeyboard()
    .url(tr.kaspiPayButton(price), config.KASPI_PAY_URL);

  await bot.api.sendMessage(
    userId,
    formatBlock(tr.kaspiPayment(price, config.SUBSCRIPTION_DAYS)),
    { parse_mode: "HTML", reply_markup: kb }
  );
}

async function showCisPayment(bot: Bot, userId: number) {
  const language = await getUserLanguageOrDefault(userId);
  const tr = t(language);
  const kb = new InlineKeyboard().url(
    tr.cisPayButton,
    "https://t.me/tribute/app?startapp=s14Dc"
  );

  await bot.api.sendMessage(
    userId,
    formatBlock(tr.cisPayment),
    { parse_mode: "HTML", reply_markup: kb }
  );
}

function receiptVerificationMessage(
  language: UserLanguage,
  code: string,
  russianMessage: string
) {
  if (language === "ru") return russianMessage;

  const messages: Record<string, string> = {
    invalid_pdf: "PDF құжатын ашу мүмкін болмады. Kaspi фискалдық чегін PDF форматында қайта жүктеп жіберіңіз.",
    pdf_unreadable: "PDF ішіндегі чек мәтінін оқу мүмкін болмады. Kaspi-ден жүктелген түпнұсқа PDF-файлды жіберіңіз.",
    not_fiscal: "PDF ішінде Kaspi ОФД фискалдық чегі расталмады.",
    amount_unreadable: "PDF-чектегі төлем сомасын сенімді түрде анықтау мүмкін болмады.",
    amount_mismatch: "Чектегі сома жазылым құнына сәйкес келмейді.",
    merchant_unreadable: "PDF-чектен сатушының ЖСН/БСН дерегін анықтау мүмкін болмады.",
    merchant_not_configured: "Төлем алушыны автоматты тексеру әлі бапталмаған.",
    merchant_mismatch: "Бұл чек Bakieva Chat төлем алушысына тиесілі емес.",
    date_unreadable: "PDF-чектен төлем күні мен уақытын анықтау мүмкін болмады.",
    receipt_id_unreadable: "Чек нөмірін немесе фискалдық деректерді оқу мүмкін болмады. Kaspi-дің түпнұсқа PDF-чегін жіберіңіз.",
    fetch_failed: "Kaspi-дің ресми чек парағы арқылы тексеру мүмкін болмады. PDF-файлды қайта жіберіңіз.",
    before_payment_session: "Бұл чек ағымдағы төлем әрекетінен бұрын жасалған. Ескі чек қабылданбайды.",
    future_date: "Чектегі күн немесе уақыт қате: төлем болашақ уақытпен көрсетілген.",
    too_old: "Бұл чекті тексеру мерзімі өтіп кеткен. Ағымдағы төлемнің PDF-чегін жіберіңіз."
  };
  return messages[code] ?? "Чекті тексеру мүмкін болмады. PDF-файлды қайта жіберіңіз.";
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
    const language = await getUserLanguageOrDefault(userId);
    const tr = t(language);
    let pending = await getPendingPaymentForUser(userId);
    if (!pending) {
      const price = await getPrice();
      await createPendingPayment(userId, price);
      pending = await getPendingPaymentForUser(userId);
    }
    if (!pending) {
      await bot.api.sendMessage(userId, tr.receiptCreateFailed);
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
      await bot.api.sendMessage(userId, `❌ ${receiptVerificationMessage(language, verification.code, verification.message)}`);
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
        tr.receiptTargetNotConfigured
      );
      return;
    }

    const approved = await approvePaymentByVerifiedReceipt(userId, verification.receipt);
    if (!approved.ok) {
      if (approved.reason === "receipt_used") {
        await bot.api.sendMessage(userId, tr.receiptUsed);
        return;
      }
      await bot.api.sendMessage(userId, tr.receiptApplyFailed);
      return;
    }

    await bot.api.sendMessage(userId, tr.receiptApproved);
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
        const language = await getUserLanguageOrDefault(userId);
        await ctx.api.sendMessage(userId, t(language).accessOnlyActive);
      } catch {
        // User may not have started the bot.
      }
    }
  });

  async function sendMainMenu(userId: number, language: UserLanguage, welcome = false) {
    const tr = t(language);
    await bot.api.sendMessage(
      userId,
      welcome ? formatBlock(tr.welcome) : tr.chooseSection,
      {
        parse_mode: welcome ? "HTML" : undefined,
        reply_markup: mainMenu(language)
      }
    );
  }

  bot.command("start", async ctx => {
    if (!ctx.from) return;
    const language = await getUserLanguage(ctx.from.id);
    if (!language) {
      await ctx.reply(t("ru").chooseLanguage, { reply_markup: languageKeyboard("start") });
      return;
    }
    await sendMainMenu(ctx.from.id, language, true);
  });

  bot.command("menu", async ctx => {
    if (!ctx.from) return;
    const language = await getUserLanguageOrDefault(ctx.from.id);
    await sendMainMenu(ctx.from.id, language);
  });

  bot.command("language", async ctx => {
    if (!ctx.from) return;
    await ctx.reply(t("ru").chooseLanguage, { reply_markup: languageKeyboard("change") });
  });

  bot.callbackQuery("menu:language", async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply(t("ru").chooseLanguage, { reply_markup: languageKeyboard("change") });
  });

  bot.callbackQuery(/^lang:(ru|kk):(start|change)$/, async ctx => {
    const language = ctx.match[1] as UserLanguage;
    const context = ctx.match[2];
    await setUserLanguage(ctx.from.id, language);
    await ctx.answerCallbackQuery({ text: t(language).languageSelected });
    await ctx.reply(t(language).languageSelected);
    await sendMainMenu(ctx.from.id, language, context === "start");
  });

  async function sendAbout(userId: number) {
    const language = await getUserLanguageOrDefault(userId);
    const tr = t(language);
    const aboutKey = language === "kk" ? "about_text_kk" : "about_text_ru";
    const contentKey = language === "kk" ? "content_text_kk" : "content_text_ru";
    const legacyAbout = language === "ru" ? await getSetting("about_text", "") : "";
    const legacyContent = language === "ru" ? await getSetting("content_text", "") : "";
    const aboutText = await getSetting(aboutKey, legacyAbout || tr.about);
    const contentText = await getSetting(contentKey, legacyContent || tr.content);
    const text = `${aboutText}\n\n${contentText}`;
    const freeUrl = await getSetting("free_channel_url", config.FREE_CHANNEL_URL ?? "");
    if (freeUrl) {
      await bot.api.sendMessage(userId, formatBlock(text), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url(tr.freeChannel, freeUrl)
      });
      return;
    }
    await bot.api.sendMessage(userId, formatBlock(text), { parse_mode: "HTML" });
  }

  bot.callbackQuery("menu:about", async ctx => {
    await ctx.answerCallbackQuery();
    await sendAbout(ctx.from.id);
  });

  bot.hears(["Подробнее о Bakieva Chat", "Bakieva Chat туралы толығырақ"], async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  bot.callbackQuery("menu:content", async ctx => {
    await ctx.answerCallbackQuery();
    await sendAbout(ctx.from.id);
  });

  bot.hears(["Что есть в чате?", "Чатта не бар?"], async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  async function sendTrial(userId: number) {
    const language = await getUserLanguageOrDefault(userId);
    const tr = t(language);
    const trialUrl = await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "");
    if (!trialUrl) {
      await bot.api.sendMessage(userId, tr.trialUnavailable);
      return;
    }
    await bot.api.sendMessage(userId, tr.trialIntro, {
      reply_markup: new InlineKeyboard().url(tr.trialButton, trialUrl)
    });
  }

  bot.callbackQuery("menu:trial", async ctx => {
    await ctx.answerCallbackQuery();
    await sendTrial(ctx.from.id);
  });

  bot.hears(["Посмотреть пробный урок", "Сынақ сабағын көру"], async ctx => {
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

  bot.hears(["Оплатить подписку", "Жазылымды төлеу"], async ctx => {
    if (!ctx.from) return;
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("pay:start", async ctx => {
    await ctx.answerCallbackQuery();
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("pay:verify", async ctx => {
    const language = await getUserLanguageOrDefault(ctx.from.id);
    const tr = t(language);
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: tr.needPaymentFirst, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: tr.sendReceipt });
    await ctx.reply(tr.sendReceiptPdf);
  });

  bot.callbackQuery("pay:claim", async ctx => {
    const language = await getUserLanguageOrDefault(ctx.from.id);
    const tr = t(language);
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: tr.needPaymentFirst, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: tr.sendReceipt });
    await ctx.reply(tr.sendReceiptPdf);
  });

  bot.hears(/https:\/\/receipt\.kaspi\.kz\/\S+/i, async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;
    const language = await getUserLanguageOrDefault(ctx.from.id);
    await ctx.reply(t(language).sendReceiptPdf);
  });

  bot.on("message:photo", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;
    const language = await getUserLanguageOrDefault(ctx.from.id);
    await ctx.reply(t(language).receiptPhotoRejected);
  });

  bot.on("message:document", async ctx => {
    if (!ctx.from) return;
    const pending = await getPendingPaymentForUser(ctx.from.id);
    if (!pending) return;

    const document = ctx.message.document;
    const filename = document.file_name?.toLowerCase() ?? "";
    const isPdf = document.mime_type === "application/pdf" || filename.endsWith(".pdf");
    const language = await getUserLanguageOrDefault(ctx.from.id);
    const tr = t(language);

    if (!isPdf) {
      await ctx.reply(tr.receiptNeedPdf);
      return;
    }

    if (document.file_size && document.file_size > 10_000_000) {
      await ctx.reply(tr.receiptTooLarge);
      return;
    }

    await ctx.reply(tr.receiptChecking);
    try {
      const pdf = await downloadTelegramFile(document.file_id);
      await processReceiptPdf(ctx.from.id, pdf);
    } catch (error) {
      console.error("PDF receipt processing failed", { userId: ctx.from.id, error });
      await ctx.reply(tr.receiptProcessingFailed);
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
    const language = await getUserLanguageOrDefault(userId);
    const tr = t(language);
    await bot.api.sendMessage(userId, tr.paymentRejected, {
      reply_markup: new InlineKeyboard().url(tr.supportButton, supportUrl())
    });
    await ctx.answerCallbackQuery({ text: "Заявка отклонена" });
    await ctx.editMessageText(`❌ Оплата #${id} отклонена администратором ${ctx.from.id}.`);
  });

  bot.callbackQuery("marketing:off", async ctx => {
    const language = await getUserLanguageOrDefault(ctx.from.id);
    const tr = t(language);
    await setMarketing(ctx.from.id, false);
    await ctx.answerCallbackQuery({ text: tr.marketingDisabledToast });
    await ctx.reply(tr.marketingDisabled);
  });

  bot.command("unsubscribe", async ctx => {
    if (!ctx.from) return;
    const language = await getUserLanguageOrDefault(ctx.from.id);
    await setMarketing(ctx.from.id, false);
    await ctx.reply(t(language).marketingDisabled);
  });

  bot.command("subscribe", async ctx => {
    if (!ctx.from) return;
    const language = await getUserLanguageOrDefault(ctx.from.id);
    await setMarketing(ctx.from.id, true);
    await ctx.reply(t(language).marketingEnabled);
  });

  bot.command("myid", async ctx => {
    if (!ctx.from) return;
    const language = await getUserLanguageOrDefault(ctx.from.id);
    await ctx.reply(t(language).telegramId(ctx.from.id));
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
      await ctx.reply("Формат: /set about_ru текст | /set about_kk мәтін | /set content_ru текст | /set content_kk мәтін | /set trial_url https://... | /set free_channel_url https://...");
      return;
    }
    const rawKey = body.slice(0, firstSpace).trim();
    const value = body.slice(firstSpace + 1).trim();
    const keys: Record<string, string> = {
      about: "about_text_ru",
      content: "content_text_ru",
      about_ru: "about_text_ru",
      about_kk: "about_text_kk",
      content_ru: "content_text_ru",
      content_kk: "content_text_kk",
      trial_url: "trial_url",
      free_channel_url: "free_channel_url"
    };
    const key = keys[rawKey];
    if (!key || !value) {
      await ctx.reply("Доступные ключи: about_ru, about_kk, content_ru, content_kk, trial_url, free_channel_url.");
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
