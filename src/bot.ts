import { Bot, InlineKeyboard, InputFile } from "grammy";
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
  getTrialPdfAsset,
  getTrialVideoAsset,
  getPaidChannelId,
  getPaidChatId,
  getUserLanguage,
  grantSubscription,
  isSubscriptionActive,
  rejectPayment,
  rememberCurrentChatMember,
  revokeSubscription,
  setMarketing,
  setPrice,
  setSetting,
  setTrialPdfTelegramFileId,
  setTrialVideoTelegramFileId,
  setUserLanguage
} from "./db.js";
import { c, localeFor, type UserLanguage } from "./i18n.js";
import { formatAdminReport } from "./admin_reports.js";
import { removeAccess, sendAccess } from "./access.js";
import { verifyKaspiReceiptPdf } from "./receipt_verifier.js";
import { registerAdminPanel } from "./admin_panel.js";
import { askAiChef, isLikelyChefQuestion } from "./ai_chef.js";

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
    .text(ui.faq1Button, "faq:1")
    .row()
    .text(ui.faq2Button, "faq:2")
    .row()
    .text(ui.faq3Button, "faq:3")
    .row()
    .text(ui.faq4Button, "faq:4")
    .row()
    .text(ui.faq5Button, "faq:5")
    .row()
    .text(ui.faq6Button, "faq:6")
    .row()
    .text(ui.faq7Button, "faq:7")
    .row()
    .text(ui.faq8Button, "faq:8")
    .row()
    .text(ui.faq9Button, "faq:9")
    .row()
    .text(ui.faq10Button, "faq:10")
    .row()
    .text(ui.faq11Button, "faq:11")
    .row()
    .text(ui.faq12Button, "faq:12")
    .row()
    .text(ui.faqMain, "menu:main");
}

function faqAnswerKeyboard(lang: UserLanguage) {
  const ui = c(lang);
  return new InlineKeyboard()
    .text(ui.faqBack, "menu:faq")
    .row()
    .text(ui.faqMain, "menu:main");
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

  async function showFaq(userId: number) {
    const lang = await languageOf(userId);
    const ui = c(lang);
    await bot.api.sendMessage(
      userId,
      `${ui.faqTitle}\n\n${ui.faqIntro}`,
      { reply_markup: faqMenu(lang) }
    );
  }

  async function showFaqAnswer(
    userId: number,
    key: "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12"
  ) {
    const lang = await languageOf(userId);
    const ui = c(lang);

    const answers = {
      "1": `${ui.faq1Q}\n\n${ui.faq1A}`,
      "2": `${ui.faq2Q}\n\n${ui.faq2A}`,
      "3": `${ui.faq3Q}\n\n${ui.faq3A}`,
      "4": `${ui.faq4Q}\n\n${ui.faq4A}`,
      "5": `${ui.faq5Q}\n\n${ui.faq5A}`,
      "6": `${ui.faq6Q}\n\n${ui.faq6A}`,
      "7": `${ui.faq7Q}\n\n${ui.faq7A}`,
      "8": `${ui.faq8Q}\n\n${ui.faq8A}`,
      "9": `${ui.faq9Q}\n\n${ui.faq9A}`,
      "10": `${ui.faq10Q}\n\n${ui.faq10A}`,
      "11": `${ui.faq11Q}\n\n${ui.faq11A}`,
      "12": `${ui.faq12Q}\n\n${ui.faq12A}`
    };

    await bot.api.sendMessage(userId, answers[key], {
      reply_markup: faqAnswerKeyboard(lang)
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

  const chefCooldown = new Map<number, number>();

  bot.command("chef_status", async ctx => {
    if (!isAdmin(ctx.from?.id)) return;
    const paidChatId = await getPaidChatId();
    const configured = Boolean(config.OPENAI_API_KEY);
    await ctx.reply(
      [
        "👨‍🍳 AI-повар-кондитер",
        "Режим: основной платный чат Bakieva Chat",
        `Chat ID: ${paidChatId || "не настроен"}`,
        `OpenAI: ${configured ? "подключён" : "API-ключ ещё не добавлен"}`
      ].join("\n")
    );
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) {
      await next();
      return;
    }

    const paidChatId = await getPaidChatId();
    if (!paidChatId || ctx.chat.id !== paidChatId) {
      await next();
      return;
    }

    const currentThreadId = ctx.message.message_thread_id ?? 0;

    const text = ctx.message.text.trim();
    if (!isLikelyChefQuestion(text)) {
      await next();
      return;
    }

    const now = Date.now();
    const previous = chefCooldown.get(ctx.from.id) ?? 0;
    if (now - previous < 8_000) {
      await next();
      return;
    }
    chefCooldown.set(ctx.from.id, now);

    if (!config.OPENAI_API_KEY) {
      if (isAdmin(ctx.from.id)) {
        await ctx.reply(
          "👨‍🍳 AI-повар-кондитер включён для основного чата, но OPENAI_API_KEY ещё не добавлен в Railway.",
          { reply_parameters: { message_id: ctx.message.message_id } }
        );
      }
      await next();
      return;
    }

    try {
      await ctx.api.sendChatAction(ctx.chat.id, "typing", {
        message_thread_id: currentThreadId || undefined
      });

      const replyContext =
        ctx.message.reply_to_message && "text" in ctx.message.reply_to_message
          ? ctx.message.reply_to_message.text ?? null
          : null;

      const answer = await askAiChef({ text, replyContext });
      if (answer) {
        await ctx.reply(answer, {
          reply_parameters: { message_id: ctx.message.message_id }
        });
      }
    } catch (error) {
      console.error("AI chef failed", {
        chatId: ctx.chat.id,
        threadId: currentThreadId,
        userId: ctx.from.id,
        error
      });
    }

    await next();
  });

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
      if (chatId === paidChatId) {
        try {
          await rememberCurrentChatMember(paidChatId, userId, "join_request");
        } catch (error) {
          console.warn("Could not remember approved paid-chat join request", {
            userId,
            error
          });
        }
      }
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
    await ctx.reply(c("ru").chooseLanguage, {
      reply_markup: languageKeyboard()
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
    const aboutKey = lang === "ru" ? "about_text_ru_v3" : "about_text_kk_v3";
    const aboutText = await getSetting(aboutKey, ui.about);

    const freeUrl = await getSetting("free_channel_url", config.FREE_CHANNEL_URL ?? "");
    if (freeUrl) {
      await bot.api.sendMessage(userId, formatBlock(aboutText), {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().url(ui.freeChannelButton, freeUrl)
      });
      return;
    }
    await bot.api.sendMessage(userId, formatBlock(aboutText), { parse_mode: "HTML" });
  }

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

  bot.callbackQuery("menu:faq", async ctx => {
    await ctx.answerCallbackQuery();
    await showFaq(ctx.from.id);
  });

  bot.callbackQuery(/^faq:(1|2|3|4|5|6|7|8|9|10|11|12)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await showFaqAnswer(
      ctx.from.id,
      ctx.match[1] as "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12"
    );
  });

  bot.callbackQuery("menu:main", async ctx => {
    const lang = await languageOf(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(c(lang).menuChoose, { reply_markup: mainMenu(lang) });
  });

  function trialVideoKeyboard(lang: UserLanguage) {
    return new InlineKeyboard()
      .text("1/2", "trial:noop")
      .text(lang === "ru" ? "PDF ➡️" : "PDF ➡️", "trial:view:pdf");
  }

  function trialPdfKeyboard(lang: UserLanguage) {
    return new InlineKeyboard()
      .text(lang === "ru" ? "⬅️ Видео" : "⬅️ Видео", "trial:view:video")
      .text("2/2", "trial:noop");
  }

  async function sendTrial(userId: number) {
    const lang = await languageOf(userId);
    const ui = c(lang);
    const asset = await getTrialVideoAsset(lang);
    const caption = ui.trialReady + "\n\n" + (
      lang === "ru"
        ? "Листайте вправо ➡️, чтобы открыть PDF-рецепт."
        : "PDF-рецептті ашу үшін оңға ➡️ өтіңіз."
    );

    if (asset?.telegramFileId) {
      await bot.api.sendVideo(userId, asset.telegramFileId, {
        caption,
        supports_streaming: true,
        protect_content: true,
        reply_markup: trialVideoKeyboard(lang)
      });
      return;
    }

    if (asset?.content?.length) {
      const filename = lang === "ru"
        ? "Bakieva_Chat_Clubnichka_RU.mp4"
        : "Bakieva_Chat_Qulpunai_KK.mp4";
      const message = await bot.api.sendVideo(
        userId,
        new InputFile(asset.content, filename),
        {
          caption,
          supports_streaming: true,
          protect_content: true,
          reply_markup: trialVideoKeyboard(lang)
        }
      );
      if (message.video?.file_id) {
        await setTrialVideoTelegramFileId(lang, message.video.file_id);
        await setSetting(`trial_video_file_id_${lang}`, message.video.file_id);
      }
      return;
    }

    const langUrlKey = lang === "ru" ? "trial_url_ru" : "trial_url_kk";
    const trialUrl = await getSetting(
      langUrlKey,
      await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "")
    );
    if (!trialUrl) {
      await bot.api.sendMessage(userId, ui.trialUnavailable);
      return;
    }

    const keyboard = new InlineKeyboard()
      .url(ui.trialWatchButton, trialUrl)
      .row()
      .text(ui.trialPdfButton, "trial:view:pdf");

    await bot.api.sendMessage(
      userId,
      ui.trialReady + "\n\n" + ui.trialPdfHint,
      { protect_content: true, reply_markup: keyboard }
    );
  }

  async function sendTrialPdf(userId: number) {
    const lang = await languageOf(userId);
    const ui = c(lang);
    const asset = await getTrialPdfAsset(lang);
    if (!asset) {
      throw new Error(`Trial PDF asset is missing for ${lang}`);
    }

    if (asset.telegramFileId) {
      await bot.api.sendDocument(
        userId,
        asset.telegramFileId,
        {
          caption: ui.trialPdfCaption,
          protect_content: true,
          reply_markup: trialPdfKeyboard(lang)
        }
      );
      return;
    }

    if (!asset.content?.length) {
      throw new Error(`Trial PDF content is missing for ${lang}`);
    }

    const message = await bot.api.sendDocument(
      userId,
      new InputFile(asset.content, asset.filename),
      {
        caption: ui.trialPdfCaption,
        protect_content: true,
        reply_markup: trialPdfKeyboard(lang)
      }
    );

    if (message.document?.file_id) {
      await setTrialPdfTelegramFileId(lang, message.document.file_id);
    }
  }

  async function deleteTrialMessage(ctx: any) {
    const message = ctx.callbackQuery?.message;
    if (!message) return;
    try {
      await ctx.api.deleteMessage(message.chat.id, message.message_id);
    } catch {
      // Navigation still works even if Telegram refuses to delete an old message.
    }
  }

  bot.callbackQuery("menu:trial", async ctx => {
    await ctx.answerCallbackQuery();
    await sendTrial(ctx.from.id);
  });

  bot.callbackQuery("trial:noop", async ctx => {
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^trial:(?:pdf|view:pdf)$/, async ctx => {
    const lang = await languageOf(ctx.from.id);
    await ctx.answerCallbackQuery({
      text: lang === "ru" ? "Открываю рецепт…" : "Рецепт ашылып жатыр…"
    });

    try {
      await sendTrialPdf(ctx.from.id);
      await deleteTrialMessage(ctx);
    } catch (error) {
      console.error("Trial recipe PDF sending failed", {
        userId: ctx.from.id,
        lang,
        error
      });
      await ctx.reply(
        lang === "ru"
          ? "Не удалось открыть PDF. Попробуйте ещё раз чуть позже."
          : "PDF файлын ашу мүмкін болмады. Сәл кейінірек қайта көріңіз."
      );
    }
  });

  bot.callbackQuery("trial:view:video", async ctx => {
    const lang = await languageOf(ctx.from.id);
    await ctx.answerCallbackQuery({
      text: lang === "ru" ? "Открываю видео…" : "Видео ашылып жатыр…"
    });

    try {
      await sendTrial(ctx.from.id);
      await deleteTrialMessage(ctx);
    } catch (error) {
      console.error("Trial video navigation failed", {
        userId: ctx.from.id,
        lang,
        error
      });
      await ctx.reply(
        lang === "ru"
          ? "Не удалось открыть видео. Попробуйте ещё раз чуть позже."
          : "Видеоны ашу мүмкін болмады. Сәл кейінірек қайта көріңіз."
      );
    }
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
      const lang = await languageOf(ctx.from.id);
      await ctx.answerCallbackQuery({ text: c(lang).openPaymentFirst, show_alert: true });
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
      await ctx.reply("Формат: /set about текст | /set about_kk мәтін | /set trial_url https://... | /set free_channel_url https://...");
      return;
    }
    const rawKey = body.slice(0, firstSpace).trim();
    const value = body.slice(firstSpace + 1).trim();
    const keys: Record<string, string> = {
      about: "about_text_ru_v3",
      about_kk: "about_text_kk_v3",
      trial_url: "trial_url",
      free_channel_url: "free_channel_url"
    };
    const key = keys[rawKey];
    if (!key || !value) {
      await ctx.reply("Доступные ключи: about, about_kk, trial_url, free_channel_url.");
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
