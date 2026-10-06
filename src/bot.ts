import { Bot, InlineKeyboard, InputFile } from "grammy";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import {
  addAiChefKnowledge,
  adminStatsForDays,
  approvePayment,
  approvePaymentByVerifiedReceipt,
  beginPaymentSession,
  beginPlanPaymentSession,
  createPendingPayment,
  ensureUser,
  getAiChefConversation,
  getMarketingUsers,
  getPendingPaymentForUser,
  listReceiptsForReview,
  getPrice,
  getSetting,
  getTrialPdfAsset,
  getTrialVideoAsset,
  getTrialVideoPair,
  getPaidChatId,
  getActiveSubscription,
  getUserLanguage,
  grantSubscription,
  hasNewPricingPayment,
  isLegacyPriceEligible,
  isStandardPriceUser,
  isSubscriptionActive,
  listAiChefKnowledge,
  listPublishedContent,
  markManagedMainChatJoinApproved,
  markStandardPriceUser,
  registerLegacyMember,
  rejectPayment,
  queueReceiptForReview,
  rememberAiChefMessage,
  rememberCurrentChatMember,
  revokeSubscription,
  setLegacyPriceEligible,
  setMarketing,
  setPrice,
  setSetting,
  setTrialPdfTelegramFileId,
  setTrialVideoTelegramFileId,
  setUserLanguage,
  deleteAiChefKnowledge
} from "./db.js";
import { c, localeFor, type UserLanguage } from "./i18n.js";
import { formatAdminReport } from "./admin_reports.js";
import { paidJoinRequestDecision, removeAccess, retryTelegram, sendAccess } from "./access.js";
import { verifyKaspiReceiptPdf } from "./receipt_verifier.js";
import { registerAdminPanel } from "./admin_panel.js";
import { askAiChef, isLikelyChefQuestion } from "./ai_chef.js";
import { getSubscriptionPlan, type PlanCode } from "./plans.js";

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

function isActiveChatMember(member: any) {
  return member?.status === "member"
    || member?.status === "administrator"
    || member?.status === "creator"
    || (member?.status === "restricted" && member?.is_member === true);
}

async function showPayment(bot: Bot, userId: number) {
  const lang = await languageOf(userId);
  const legacyEligible = await isLegacyPriceEligible(userId);
  const kb = new InlineKeyboard();

  if (legacyEligible) {
    kb.text(
      lang === "ru" ? "💗 Льготный тариф — 5 000 ₸ / 30 дней" : "💗 Арнайы тариф — 5 000 ₸ / 30 күн",
      "pay:plan:legacy_monthly"
    );
  } else {
    kb.text(
      lang === "ru" ? "💳 10 000 ₸ — 30 дней" : "💳 10 000 ₸ — 30 күн",
      "pay:plan:monthly"
    )
      .row()
      .text(
        lang === "ru" ? "⭐ 25 000 ₸ — 5 месяцев" : "⭐ 25 000 ₸ — 5 ай",
        "pay:plan:five_months"
      );
  }
  kb.row().text(c(lang).faqMain, "menu:main");

  await bot.api.sendMessage(
    userId,
    legacyEligible
      ? (lang === "ru"
          ? "Для вашего аккаунта сохранён акционный тариф 5 000 ₸ за 30 дней. Выберите тариф для продления:"
          : "Сіздің аккаунтыңыз үшін 30 күнге 5 000 ₸ арнайы тариф сақталған. Ұзарту тарифін таңдаңыз:")
      : (lang === "ru"
          ? "Выберите тариф Bakieva Chat:\n\n• 10 000 ₸ — доступ на 30 дней\n• 25 000 ₸ — доступ на 150 дней (5 месяцев)"
          : "Bakieva Chat тарифін таңдаңыз:\n\n• 10 000 ₸ — 30 күнге қолжетімділік\n• 25 000 ₸ — 150 күнге (5 ай) қолжетімділік"),
    { reply_markup: kb }
  );
}

async function showSelectedPlanPayment(bot: Bot, userId: number, planCode: PlanCode) {
  const lang = await languageOf(userId);
  const ui = c(lang);
  const plan = getSubscriptionPlan(planCode);
  if (!plan) throw new Error("Unknown subscription plan");

  if (plan.code === "legacy_monthly" && !(await isLegacyPriceEligible(userId))) {
    await bot.api.sendMessage(
      userId,
      lang === "ru"
        ? "Льготный тариф 5 000 ₸ доступен только участникам сохранённой акционной группы."
        : "5 000 ₸ арнайы тариф тек акция тобына енгізілген қатысушыларға қолжетімді."
    );
    return;
  }

  await beginPlanPaymentSession(userId, plan.code, plan.amount, plan.durationDays);
  const kaspiUrl = await getSetting("kaspi_pay_url", config.KASPI_PAY_URL);
  const formattedPrice = plan.amount.toLocaleString(localeFor(lang));
  const duration =
    plan.code === "five_months"
      ? (lang === "ru" ? "5 месяцев" : "5 ай")
      : (lang === "ru" ? "30 дней" : "30 күн");

  const kb = new InlineKeyboard()
    .url(`${ui.kaspiButton} — ${formattedPrice} ₸`, kaspiUrl)
    .row()
    .text(ui.faqMain, "menu:main");

  await bot.api.sendMessage(
    userId,
    lang === "ru"
      ? `Выбран тариф: ${formattedPrice} ₸ — ${duration}.\n\nОплатите точную сумму через Kaspi. После оплаты скачайте фискальный чек Kaspi в формате PDF и отправьте PDF-файл сюда. Бот сверит сумму, получателя и данные чека и активирует именно выбранный срок доступа.`
      : `Таңдалған тариф: ${formattedPrice} ₸ — ${duration}.\n\nKaspi арқылы дәл осы соманы төлеңіз. Төлемнен кейін Kaspi фискалдық чегін PDF форматында жүктеп, осы чатқа жіберіңіз. Бот соманы және чек деректерін тексеріп, таңдалған мерзімге қолжетімділікті белсендіреді.`,
    { reply_markup: kb }
  );
}

async function showCisPayment(bot: Bot, userId: number) {
  const lang = await languageOf(userId);
  const ui = c(lang);
  const kb = new InlineKeyboard()
    .url(
      ui.cisPayButton,
      "https://t.me/tribute/app?startapp=s18n3"
    )
    .row()
    .text(ui.faqMain, "menu:main");

  await bot.api.sendMessage(
    userId,
    formatBlock(ui.cisPaymentText),
    { parse_mode: "HTML", reply_markup: kb }
  );
}

export function createBot() {
  const bot = new Bot(config.BOT_TOKEN);

  async function removeCallbackScreen(ctx: any) {
    const message = ctx.callbackQuery?.message;
    if (!message) return;
    try {
      await ctx.api.deleteMessage(message.chat.id, message.message_id);
    } catch {
      // Navigation continues even when Telegram cannot delete an old message.
    }
  }

  async function claimLegacy5000(userId: number) {
    if (await isLegacyPriceEligible(userId)) {
      return { ok: true as const, already: true as const };
    }

    const closedAt = await getSetting("legacy_5000_claim_closed_at", "");
    if (closedAt) {
      return { ok: false as const, reason: "closed" as const };
    }

    // A join observed after the pricing cutoff is explicitly marked as standard.
    // This prevents any new member from claiming the grandfathered 5k price.
    if (await isStandardPriceUser(userId)) {
      return { ok: false as const, reason: "new_pricing" as const };
    }

    // Anyone who has already paid one of the new 10k/25k plans is a new-pricing
    // customer and must never be converted into the grandfathered 5k cohort.
    if (await hasNewPricingPayment(userId)) {
      return { ok: false as const, reason: "new_pricing" as const };
    }

    const paidChatId = await getPaidChatId();
    if (!paidChatId) {
      return { ok: false as const, reason: "chat_not_configured" as const };
    }

    try {
      const member = await bot.api.getChatMember(paidChatId, userId);
      if (!isActiveChatMember(member)) {
        return { ok: false as const, reason: "not_member" as const };
      }

      await setLegacyPriceEligible(userId, true, "verified_old_paid_chat_2026-10-06");
      await registerLegacyMember(userId);
      await rememberCurrentChatMember(paidChatId, userId, "manual");
      return { ok: true as const, already: false as const };
    } catch (error: any) {
      if (error?.error_code === 400 || error?.error_code === 403) {
        return { ok: false as const, reason: "not_member" as const };
      }
      throw error;
    }
  }

  async function markPostCutoffJoinAsStandard(
    chatId: number,
    userId: number,
    source: string
  ) {
    const paidChatId = await getPaidChatId();
    if (!paidChatId || chatId !== paidChatId) return;

    const cutoffAt = await getSetting("legacy_5000_cutoff_at", "");
    if (!cutoffAt) return;

    await markStandardPriceUser(userId, source);
  }

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
    if (!response.body) throw new Error("Empty Telegram download");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > 10_000_000) throw new Error("Receipt PDF is too large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function sendReviewToAdmins(id: number, userId: number, amount: number, fileId: string,
    reason: string, recipients: Iterable<number> = config.adminIds) {
    const buttons = new InlineKeyboard()
      .text("✅ Оплата сверена с Kaspi", `pay:approve:${id}`)
      .row().text("❌ Отклонить", `pay:reject:${id}`);
    for (const adminId of recipients) {
      try {
        await bot.api.sendDocument(adminId, fileId, {
          caption: `Чек #${id}, пользователь ${userId}, сумма ${amount} ₸. Автопроверка: ${reason}. Проверьте подлинность и поступление оплаты в Kaspi до подтверждения.`,
          reply_markup: buttons
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "receipt_review_notification_failed", paymentId: id, adminId,
          errorType: error instanceof Error ? error.name : "Error" }));
      }
    }
  }

  async function processReceiptPdf(userId: number, pdf: Buffer, fileId: string) {
    const lang = await languageOf(userId);
    const ui = c(lang);
    const pending = await getPendingPaymentForUser(userId);
    if (!pending) {
      await bot.api.sendMessage(
        userId,
        lang === "ru"
          ? "Сначала откройте раздел оплаты и выберите тариф. После этого отправьте PDF-чек."
          : "Алдымен төлем бөлімін ашып, тарифті таңдаңыз. Содан кейін PDF-чекті жіберіңіз."
      );
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
      console.info(JSON.stringify({ event: "receipt_verification_failed", userId, code: verification.code }));
      if (["receipt_id_unreadable", "fetch_failed", "not_fiscal", "amount_unreadable",
        "merchant_unreadable", "date_unreadable"].includes(verification.code)) {
        const hash = createHash("sha256").update(pdf).digest("hex");
        const queued = await queueReceiptForReview(userId, hash, fileId, verification.code);
        if (queued.status === "used") { await bot.api.sendMessage(userId, ui.receiptUsed); return; }
        if (queued.status === "already_pending") {
          await bot.api.sendMessage(userId, ui.receiptReviewPending);
          return;
        }
        if (queued.status === "queued") {
          if (queued.isNew) await sendReviewToAdmins(queued.id, userId, pending.amount, fileId, verification.code);
          await bot.api.sendMessage(userId, ui.receiptReviewPending);
          return;
        }
      }
      const localized =
        ui.receiptErrors[verification.code as keyof typeof ui.receiptErrors] ??
        verification.message;
      await bot.api.sendMessage(userId, `❌ ${localized.replace(/^❌\s*/, "")}`);
      return;
    }

    console.info(JSON.stringify({ event: "receipt_verified", userId }));

    const approved = await approvePaymentByVerifiedReceipt(userId, verification.receipt,
      createHash("sha256").update(pdf).digest("hex"));
    if (!approved.ok) {
      if (approved.reason === "receipt_used") {
        await bot.api.sendMessage(userId, ui.receiptUsed);
        return;
      }
      await bot.api.sendMessage(userId, ui.receiptApplyFailed);
      return;
    }

    if (approved.newlyApproved) {
      console.info(JSON.stringify({ event: "payment_approved", userId, paymentId: approved.paymentId }));
      console.info(JSON.stringify({ event: "subscription_activated", userId, paymentId: approved.paymentId }));
    }

    try {
      if (approved.newlyApproved) await bot.api.sendMessage(userId, ui.receiptApproved);
      await sendAccess(bot, userId, approved.activeUntil);
    } catch (error) {
      console.error("Automatic access delivery failed after verified receipt", {
        userId,
        paymentId: approved.paymentId,
        error
      });

      try {
        await bot.api.sendMessage(userId, lang === "ru"
          ? "✅ Оплата подтверждена, подписка активна. Возникла техническая проблема с выдачей доступа. Повторно оплачивать не нужно."
          : "✅ Төлем расталды, жазылым белсенді. Қолжетімділікті беруде техникалық мәселе туындады. Қайта төлеудің қажеті жоқ.");
      } catch (notifyError) { console.error("access_user_notification_failed", { userId, notifyError }); }

      for (const adminId of config.adminIds) {
        try {
          await bot.api.sendMessage(
            adminId,
            [
              "⚠️ Оплата подтверждена, но ссылки доступа не выданы",
              `Пользователь: ${userId}`,
              `Платёж: #${approved.paymentId}`,
              "Проверьте права бота на создание пригласительных ссылок и привязку платного чата/канала."
            ].join("\n")
          );
        } catch (notifyError) {
          console.error("Could not notify admin about access delivery failure", {
            adminId,
            userId,
            notifyError
          });
        }
      }
    }
  }

  bot.use(async (ctx, next) => {
    if (ctx.from) await ensureUser(ctx.from);
    await next();
  });

  registerAdminPanel(bot);

  function isChefAdminCommand(ctx: any) {
    const anonymousAdmin =
      (ctx.chat?.type === "group" || ctx.chat?.type === "supergroup") &&
      ctx.message?.sender_chat?.id === ctx.chat.id;

    return isAdmin(ctx.from?.id) || anonymousAdmin;
  }

  async function buildAiChefKnowledge(language: UserLanguage) {
    const ui = c("ru");
    const [customKnowledge, published] = await Promise.all([
      listAiChefKnowledge(language, 50),
      listPublishedContent(50)
    ]);

    const base = [
      "О Bakieva Chat:",
      "• Для новых участников: 10 000 ₸ за 30 дней или 25 000 ₸ за 150 дней (5 месяцев).",
      "• Для участников сохранённой акционной группы действует персональный тариф 5 000 ₸ за 30 дней.",
      "• Подписку можно оплатить на один месяц и потом не продлевать.",
      "• Для Казахстана оплата идёт через Kaspi в боте. Для других стран в боте есть отдельная кнопка оплаты.",
      "• За 3 дня до окончания доступа бот напоминает о продлении. После повторной оплаты новый срок добавляется к действующему.",
      `• ${ui.faq1A}`,
      `• ${ui.faq3A}`,
      `• ${ui.faq4A}`,
      `• ${ui.faq5A}`,
      `• ${ui.faq7A}`,
      `• ${ui.faq8A}`,
      `• ${ui.faq9A}`,
      `• ${ui.faq10A}`,
      `• ${ui.faq11A}`,
      `• ${ui.faq12A}`,
      "• Бесплатный пробный материал: урок «Корпусная клубничка» с видео и PDF-рецептом.",
      "Важно: если конкретного рецепта, урока, таблицы или точной навигации нет ниже в каталоге/базе знаний, нельзя утверждать, что он есть или что его нет."
    ];

    const custom = customKnowledge.map(item =>
      `[База #${item.id}] ${item.title}: ${item.body}`
    );

    const catalog = published
      .filter(item => item.title || item.body)
      .map(item => {
        const title = item.title?.trim() || `Материал #${item.id}`;
        const body = item.body?.trim() || "";
        return `[Опубликованный материал #${item.id}] ${title}${body ? `: ${body.slice(0, 900)}` : ""}`;
      });

    return [
      ...base,
      custom.length ? "\nДополнительная база знаний, добавленная администратором:" : "",
      ...custom,
      catalog.length ? "\nКаталог материалов, опубликованных через бота:" : "",
      ...catalog
    ].filter(Boolean).join("\n").slice(0, 15500);
  }

  bot.command("bind_chef", async ctx => {
    if (!isChefAdminCommand(ctx)) return;
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      await ctx.reply("Команду /bind_chef нужно отправить прямо в чате или теме «Болталка».");
      return;
    }

    const threadId = ctx.message?.message_thread_id ?? 0;
    await setSetting("ai_chef_chat_id", String(ctx.chat.id));
    await setSetting("ai_chef_thread_id", String(threadId));

    await ctx.reply(
      threadId
        ? "✅ AI-шеф привязан к этой теме. Он понимает кондитерские вопросы и вопросы о Bakieva Chat."
        : "✅ AI-шеф привязан к этому чату. Он понимает кондитерские вопросы и вопросы о Bakieva Chat."
    );
  });

  bot.command("unbind_chef", async ctx => {
    if (!isChefAdminCommand(ctx)) return;
    await setSetting("ai_chef_chat_id", "");
    await setSetting("ai_chef_thread_id", "");
    await ctx.reply("✅ AI-шеф отключён от чата.");
  });

  bot.command("chef_status", async ctx => {
    if (!isChefAdminCommand(ctx)) return;
    const chatId = await getSetting("ai_chef_chat_id", "");
    const threadId = await getSetting("ai_chef_thread_id", "");
    const configured = Boolean(config.OPENAI_API_KEY);
    const knowledge = await listAiChefKnowledge("ru", 80);
    await ctx.reply(
      [
        "👨‍🍳 AI-шеф",
        `Чат: ${chatId || "не привязан"}`,
        `Тема: ${threadId && threadId !== "0" ? threadId : "весь привязанный чат"}`,
        `OpenAI: ${configured ? "подключён" : "API-ключ ещё не добавлен"}`,
        `Дополнительная база знаний: ${knowledge.length} записей`
      ].join("\n")
    );
  });

  bot.command("chef_add", async ctx => {
    if (!isChefAdminCommand(ctx)) return;
    const raw = (ctx.message?.text ?? "")
      .replace(/^\/chef_add(?:@\w+)?\s*/i, "")
      .trim();

    if (!raw) {
      await ctx.reply(
        "Добавьте знание так:\n/chef_add Название | точная информация для AI-шефа\n\nНапример:\n/chef_add Себестоимость | Таблица себестоимости находится в разделе ..."
      );
      return;
    }

    const separator = raw.indexOf("|");
    const title = (separator >= 0 ? raw.slice(0, separator) : raw.slice(0, 80)).trim();
    const body = (separator >= 0 ? raw.slice(separator + 1) : raw).trim();

    if (!title || !body) {
      await ctx.reply("Нужен формат: /chef_add Название | информация");
      return;
    }

    const item = await addAiChefKnowledge({
      language: "all",
      title,
      body,
      createdBy: isAdmin(ctx.from?.id) ? (ctx.from?.id ?? null) : null
    });
    await ctx.reply(`✅ Добавлено в базу AI-шефа: #${item.id} «${item.title}»`);
  });

  bot.command("chef_kb", async ctx => {
    if (!isChefAdminCommand(ctx)) return;
    const items = await listAiChefKnowledge("ru", 30);
    if (!items.length) {
      await ctx.reply("Дополнительная база AI-шефа пока пустая. Используйте /chef_add.");
      return;
    }

    const lines = items.map(item =>
      `#${item.id} — ${item.title}: ${item.body.slice(0, 180)}`
    );
    await ctx.reply(
      ("🧠 База знаний AI-шефа:\n\n" + lines.join("\n\n")).slice(0, 3900)
    );
  });

  bot.command("chef_delete", async ctx => {
    if (!isChefAdminCommand(ctx)) return;
    const raw = (ctx.message?.text ?? "")
      .replace(/^\/chef_delete(?:@\w+)?\s*/i, "")
      .trim();
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      await ctx.reply("Укажите ID: /chef_delete 12");
      return;
    }

    const deleted = await deleteAiChefKnowledge(id);
    await ctx.reply(deleted ? `✅ Запись #${id} удалена.` : `Запись #${id} не найдена.`);
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) {
      await next();
      return;
    }

    const boundChatId = Number(await getSetting("ai_chef_chat_id", "0"));
    if (!Number.isSafeInteger(boundChatId) || boundChatId === 0 || ctx.chat.id !== boundChatId) {
      await next();
      return;
    }

    const boundThreadId = Number(await getSetting("ai_chef_thread_id", "0"));
    const currentThreadId = ctx.message.message_thread_id ?? 0;
    if (boundThreadId !== currentThreadId) {
      await next();
      return;
    }

    const text = ctx.message.text.trim();
    const history = await getAiChefConversation(
      ctx.chat.id,
      currentThreadId,
      ctx.from.id,
      10,
      45
    );

    if (!isLikelyChefQuestion(text, history.length > 0)) {
      await next();
      return;
    }

    if (!config.OPENAI_API_KEY) {
      if (isAdmin(ctx.from.id)) {
        await ctx.reply(
          "👨‍🍳 AI-шеф привязан правильно, но OPENAI_API_KEY ещё не добавлен в Railway.",
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

      const language = await languageOf(ctx.from.id);
      const knowledge = await buildAiChefKnowledge(language);
      const answer = await askAiChef({
        text,
        replyContext,
        history: history.map(item => ({
          role: item.role,
          content: item.content
        })),
        knowledge
      });

      if (answer) {
        await rememberAiChefMessage({
          chatId: ctx.chat.id,
          threadId: currentThreadId,
          userId: ctx.from.id,
          role: "user",
          content: text
        });
        await rememberAiChefMessage({
          chatId: ctx.chat.id,
          threadId: currentThreadId,
          userId: ctx.from.id,
          role: "assistant",
          content: answer
        });

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
      try {
        await ctx.reply(
          "👨‍🍳 Сейчас не получилось сформировать ответ. Попробуйте повторить вопрос через несколько секунд.",
          { reply_parameters: { message_id: ctx.message.message_id } }
        );
      } catch {
        // Avoid a secondary Telegram error hiding the original AI failure.
      }
    }

    await next();
  });

  bot.on("chat_join_request", async ctx => {
    const request = ctx.chatJoinRequest;
    const chatId = request.chat.id;
    const userId = request.from.id;
    const { action, mainChatId } = await paidJoinRequestDecision(chatId, userId, request.invite_link?.invite_link);
    if (action === "ignore") return;
    if (action === "approve") {
      try { await retryTelegram(() => ctx.api.approveChatJoinRequest(chatId, userId)); }
      catch (error) {
        const details = error as { error_code?: number; description?: string };
        if (details.error_code === 400 && /request.*(not found|missing|already)|HIDE_REQUESTER_MISSING/i.test(details.description ?? "")) return;
        throw error;
      }
      if (chatId === mainChatId) {
        try {
          const stored = await markManagedMainChatJoinApproved(userId, request.invite_link?.invite_link);
          if (!stored) console.error("Approved paid-chat join was not recorded", { userId, chatId });
          await rememberCurrentChatMember(mainChatId, userId, "join_request");
          await markPostCutoffJoinAsStandard(mainChatId, userId, "post_cutoff_join_request");
        } catch (error) {
          console.error("Could not persist approved paid-chat join request", {
            userId,
            error
          });
        }
      }
    } else {
      try { await retryTelegram(() => ctx.api.declineChatJoinRequest(chatId, userId)); }
      catch (error) {
        const details = error as { error_code?: number; description?: string };
        if (details.error_code === 400 && /request.*(not found|missing|already)|HIDE_REQUESTER_MISSING/i.test(details.description ?? "")) return;
        throw error;
      }
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

    const payload = ctx.message?.text?.trim().split(/\s+/)[1]?.toLowerCase() ?? "";
    if (payload === "legacy5000") {
      try {
        const result = await claimLegacy5000(ctx.from.id);
        if (result.ok) {
          const lang = await languageOf(ctx.from.id);
          await ctx.reply(
            result.already
              ? (lang === "ru"
                  ? "✅ Ваш персональный тариф 5 000 ₸ за 30 дней уже сохранён."
                  : "✅ Сіздің 30 күнге 5 000 ₸ жеке тарифіңіз бұрыннан сақталған.")
              : (lang === "ru"
                  ? "✅ Ваш старый тариф сохранён. Для вас стоимость остаётся 5 000 ₸ за 30 дней. Мы закрепили этот тариф за вашим Telegram ID — при следующих продлениях цена для вас не изменится."
                  : "✅ Дайын. Сіздің бұрынғы Bakieva Chat қатысушысы екеніңіз расталды. 30 күнге 5 000 ₸ тариф Telegram ID-іңізге бекітілді және келесі ұзартуларда сақталады."),
            { reply_markup: new InlineKeyboard().text(c(lang).renewButton, "pay:start") }
          );
          return;
        }

        if (result.reason === "new_pricing") {
          await ctx.reply(
            "Этот аккаунт уже относится к новой тарифной сетке 10 000/25 000 ₸. Льготный тариф 5 000 ₸ автоматически не назначен."
          );
          return;
        }

        if (result.reason === "closed") {
          await ctx.reply(
            "Регистрация старого тарифа 5 000 ₸ уже закрыта. Если вы были старым участником и не успели закрепить цену, обратитесь к администратору."
          );
          return;
        }

        if (result.reason === "chat_not_configured") {
          await ctx.reply("Не удалось проверить старый Bakieva Chat. Обратитесь в поддержку.");
          return;
        }

        await ctx.reply(
          "Не удалось подтвердить, что этот Telegram-аккаунт состоит в старом платном Bakieva Chat. Если вы старый участник, откройте эту кнопку именно тем аккаунтом, который находится в чате."
        );
        return;
      } catch (error) {
        console.error("Legacy 5000 claim failed", { userId: ctx.from.id, error });
        await ctx.reply("Не удалось сохранить старый тариф из-за технической ошибки. Попробуйте ещё раз.");
        return;
      }
    }

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

  bot.command("help", async ctx => {
    if (!ctx.from) return;
    const lang = await languageOf(ctx.from.id);
    await ctx.reply(lang === "ru"
      ? "Команды: /start, /menu, /language, /access, /privacy. Если доступ после оплаты не пришёл, отправьте /access или обратитесь в поддержку."
      : "Командалар: /start, /menu, /language, /access, /privacy. Төлемнен кейін қолжетімділік келмесе, /access жіберіңіз немесе қолдау қызметіне жазыңыз.",
      { reply_markup: mainMenu(lang) });
  });

  bot.command("privacy", async ctx => {
    if (!ctx.from) return;
    const lang = await languageOf(ctx.from.id);
    await ctx.reply(lang === "ru" ? "Политика конфиденциальности:" : "Құпиялылық саясаты:", {
      reply_markup: new InlineKeyboard().url(lang === "ru" ? "Открыть" : "Ашу", config.PRIVACY_URL)
    });
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
        reply_markup: new InlineKeyboard()
          .url(ui.freeChannelButton, freeUrl)
          .row()
          .text(ui.faqMain, "menu:main")
      });
      return;
    }
    await bot.api.sendMessage(userId, formatBlock(aboutText), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(ui.faqMain, "menu:main")
    });
  }

  bot.callbackQuery("menu:about", async ctx => {
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await sendAbout(ctx.from.id);
  });

  bot.hears(/^(Подробнее о Bakieva Chat|Bakieva Chat туралы толығырақ)$/i, async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  bot.callbackQuery("menu:content", async ctx => {
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await sendAbout(ctx.from.id);
  });

  bot.hears(/^(Что есть в чате\?|Чатта не бар\?)$/i, async ctx => {
    if (!ctx.from) return;
    await sendAbout(ctx.from.id);
  });

  bot.callbackQuery("menu:faq", async ctx => {
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await showFaq(ctx.from.id);
  });

  bot.callbackQuery(/^faq:(1|2|3|4|5|6|7|8|9|10|11|12)$/, async ctx => {
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await showFaqAnswer(
      ctx.from.id,
      ctx.match[1] as "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12"
    );
  });

  bot.callbackQuery("menu:main", async ctx => {
    const lang = await languageOf(ctx.from.id);
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await ctx.reply(c(lang).menuChoose, { reply_markup: mainMenu(lang) });
  });

  function trialVideoKeyboard(lang: UserLanguage) {
    return new InlineKeyboard()
      .text("1/2", "trial:noop")
      .text(lang === "ru" ? "PDF ➡️" : "PDF ➡️", "trial:view:pdf")
      .row()
      .text(c(lang).faqMain, "menu:main");
  }

  function trialPdfKeyboard(lang: UserLanguage) {
    return new InlineKeyboard()
      .text(lang === "ru" ? "⬅️ Видео" : "⬅️ Видео", "trial:view:video")
      .text("2/2", "trial:noop")
      .row()
      .text(c(lang).faqMain, "menu:main");
  }

  async function sendTrial(userId: number) {
    const lang = await languageOf(userId);
    const ui = c(lang);

    if (lang === "ru" || lang === "kk") {
      const pair = await getTrialVideoPair(lang);
      const part1 = pair?.part1;
      const part2 = pair?.part2;

      if (part1 && part2 && pair) {
        const part1Options = {
          caption: ui.trialReady + "\n\n" + (
            lang === "ru" ? "Часть 1 из 2" : "1-бөлім / 2"
          ),
          protect_content: true
        };
        if (pair.part1MediaType === "document") {
          await bot.api.sendDocument(userId, part1, part1Options);
        } else {
          await bot.api.sendVideo(userId, part1, {
            ...part1Options,
            supports_streaming: true
          });
        }

        const part2Options = {
          caption: lang === "ru"
            ? "Часть 2 из 2\n\nЛистайте вправо ➡️, чтобы открыть PDF-рецепт."
            : "2-бөлім / 2\n\nPDF-рецептті ашу үшін оңға ➡️ өтіңіз.",
          protect_content: true,
          reply_markup: trialVideoKeyboard(lang)
        };
        if (pair.part2MediaType === "document") {
          await bot.api.sendDocument(userId, part2, part2Options);
        } else {
          await bot.api.sendVideo(userId, part2, {
            ...part2Options,
            supports_streaming: true
          });
        }
        return;
      }
    }

    const asset = await getTrialVideoAsset(lang);
    const caption = ui.trialReady + "\n\n" + (
      lang === "ru"
        ? "Листайте вправо ➡️, чтобы открыть PDF-рецепт."
        : "PDF-рецептті ашу үшін оңға ➡️ өтіңіз."
    );

    if (asset?.telegramFileId) {
      const options = {
        caption,
        protect_content: true,
        reply_markup: trialVideoKeyboard(lang)
      };
      if (asset.telegramMediaType === "document") {
        await bot.api.sendDocument(userId, asset.telegramFileId, options);
      } else {
        await bot.api.sendVideo(userId, asset.telegramFileId, {
          ...options,
          supports_streaming: true
        });
      }
      return;
    }

    if (asset?.content?.length) {
      const message = await bot.api.sendDocument(
        userId,
        new InputFile(asset.content, asset.filename),
        {
          caption,
          disable_content_type_detection: true,
          protect_content: true,
          reply_markup: trialVideoKeyboard(lang)
        }
      );
      if (message.document?.file_id) {
        await setTrialVideoTelegramFileId(lang, message.document.file_id, "document");
        await setSetting(`trial_video_file_id_${lang}`, message.document.file_id);
        await setSetting(`trial_video_media_type_${lang}`, "document");
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
      .text(ui.trialPdfButton, "trial:view:pdf")
      .row()
      .text(ui.faqMain, "menu:main");

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
    await removeCallbackScreen(ctx);
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
    await removeCallbackScreen(ctx);
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("menu:pay:cis", async ctx => {
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await showCisPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("menu:pay", async ctx => {
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await showPayment(bot, ctx.from.id);
  });

  bot.hears(/^(Оплатить подписку|Жазылымды төлеу)$/i, async ctx => {
    if (!ctx.from) return;
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("pay:start", async ctx => {
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery(/^pay:plan:(legacy_monthly|monthly|five_months)$/, async ctx => {
    const planCode = ctx.match[1] as PlanCode;
    if (planCode === "legacy_monthly" && !(await isLegacyPriceEligible(ctx.from.id))) {
      await ctx.answerCallbackQuery({
        text: "Этот тариф недоступен для вашего аккаунта",
        show_alert: true
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await removeCallbackScreen(ctx);
    await showSelectedPlanPayment(bot, ctx.from.id, planCode);
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
    const document = ctx.message.document;
    const isPdf = document.mime_type === "application/pdf";
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
      await processReceiptPdf(ctx.from.id, pdf, document.file_id);
    } catch (error) {
      console.error("PDF receipt processing failed", { userId: ctx.from.id, error });
      const active = await getActiveSubscription(ctx.from.id).catch(() => null);
      await ctx.reply(active
        ? (lang === "ru" ? "Подписка активна. Если ссылки не пришли, отправьте /access — повторно оплачивать не нужно." : "Жазылым белсенді. Сілтемелер келмесе, /access жіберіңіз — қайта төлемеңіз.")
        : ui.pdfFailed);
    }
  });

  bot.command("access", async ctx => {
    if (!ctx.from) return;
    const activeUntil = await getActiveSubscription(ctx.from.id);
    if (!activeUntil) { await ctx.reply(c(await languageOf(ctx.from.id)).paidOnly); return; }
    try { await sendAccess(bot, ctx.from.id, activeUntil); }
    catch { await ctx.reply((await languageOf(ctx.from.id)) === "ru"
      ? "Подписка активна, но ссылки пока не удалось выдать. Повторно оплачивать не нужно."
      : "Жазылым белсенді, бірақ сілтемелер әлі берілмеді. Қайта төлемеңіз."); }
  });

  bot.command("review_receipts", async ctx => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    const pending = await listReceiptsForReview();
    if (!pending.length) { await ctx.reply("Чеков на ручной проверке нет."); return; }
    for (const payment of pending) {
      await sendReviewToAdmins(Number(payment.id), Number(payment.user_id), Number(payment.amount),
        payment.file_id, payment.reason, [ctx.from.id]);
    }
    await ctx.reply(`Чеков на проверке: ${pending.length}. Подтвердите оплату только после сверки с Kaspi.`);
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
    try { await sendAccess(bot, approved.userId, approved.activeUntil); }
    catch (error) {
      console.error(JSON.stringify({ event: "admin_approved_access_pending", paymentId: id,
        errorType: error instanceof Error ? error.name : "Error" }));
      try {
        const lang = await languageOf(approved.userId);
        await bot.api.sendMessage(approved.userId, lang === "ru"
          ? "✅ Оплата подтверждена, подписка активна. Ссылки пока не удалось отправить. Повторно оплачивать не нужно. Отправьте /access."
          : "✅ Төлем расталды, жазылым белсенді. Сілтемелер әзірге жіберілмеді. Қайта төлемеңіз. /access жіберіңіз.");
      } catch (notifyError) { console.error("access_user_notification_failed", { paymentId: id,
        errorType: notifyError instanceof Error ? notifyError.name : "Error" }); }
    }
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
    if (!ctx.from || !isAdmin(ctx.from.id)) return;
    await ctx.reply(
      "Тарифы настроены по новой схеме:\n• старые акционные участники — 5 000 ₸ / 30 дней\n• новые — 10 000 ₸ / 30 дней\n• новые — 25 000 ₸ / 150 дней.\n\nЛьготный статус: /legacy_price TELEGRAM_ID on|off"
    );
  });

  bot.command("legacy_price", async ctx => {
    if (!ctx.from || !ctx.message || !isAdmin(ctx.from.id)) return;
    const [, rawUserId, rawMode] = ctx.message.text.trim().split(/\s+/);
    const userId = Number(rawUserId);
    const mode = rawMode?.toLowerCase();
    if (!Number.isSafeInteger(userId) || userId <= 0 || (mode !== "on" && mode !== "off")) {
      await ctx.reply("Формат: /legacy_price TELEGRAM_ID on|off");
      return;
    }
    const enabled = mode === "on";
    await setLegacyPriceEligible(userId, enabled, `admin:${ctx.from.id}`);
    await ctx.reply(
      enabled
        ? `✅ Для ${userId} сохранён тариф 5 000 ₸ / 30 дней.`
        : `✅ Для ${userId} льготный тариф отключён. Будут доступны тарифы 10 000 ₸ и 25 000 ₸.`
    );
  });

  bot.command("kaspi_url", async ctx => {
    if (!ctx.from || !ctx.message || !isAdmin(ctx.from.id)) return;
    const value = ctx.message.text.replace(/^\/kaspi_url(?:@\w+)?\s*/i, "").trim();
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "pay.kaspi.kz") {
        throw new Error("Wrong Kaspi host");
      }
    } catch {
      await ctx.reply("Формат: /kaspi_url https://pay.kaspi.kz/pay/...");
      return;
    }
    await setSetting("kaspi_pay_url", value);
    await ctx.reply("✅ Ссылка Kaspi Pay обновлена. Новые платежи сразу будут открывать её.");
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
