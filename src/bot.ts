import { Bot, InlineKeyboard } from "grammy";
import { config, CONSENT_VERSION } from "./config.js";
import {
  acceptConsent,
  approvePayment,
  createPendingPayment,
  ensureUser,
  getMarketingUsers,
  getPrice,
  getSetting,
  grantSubscription,
  hasConsent,
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

function mainMenu() {
  return new InlineKeyboard()
    .text("🇰🇿 Оплатить доступ — Казахстан", "menu:pay")
    .row()
    .text("📘 Подробнее о Bakieva Chat", "menu:about")
    .row()
    .text("🌍 Оплатить доступ — страны СНГ", "menu:pay_cis")
    .row()
    .text("🔥 Бесплатный пробный урок", "menu:trial")
    .row()
    .text("🧑🏻‍💼 Служба поддержки", "menu:support");
}

function isAdmin(id?: number) {
  return typeof id === "number" && config.adminIds.has(id);
}

function supportUrl() {
  const digits = config.SUPPORT_PHONE.replace(/\D/g, "");
  return `tg://resolve?phone=${digits}`;
}

function documentsKeyboard(paymentMethod: "kaspi" | "tribute" = "kaspi") {
  return new InlineKeyboard()
    .url("📄 Публичная оферта", config.OFFER_URL)
    .row()
    .url("🔐 Политика конфиденциальности", config.PRIVACY_URL)
    .row()
    .url("✅ Согласие на обработку данных", config.DATA_CONSENT_URL)
    .row()
    .url("🔁 Условия подписки и возврата", config.SUBSCRIPTION_TERMS_URL)
    .row()
    .text("Я прочитал(а) и принимаю условия", `consent:accept:${paymentMethod}`);
}

async function showPayment(bot: Bot, userId: number) {
  const price = await getPrice();
  const kb = new InlineKeyboard()
    .url(`Оплатить ${price.toLocaleString("ru-RU")} ₸ через Kaspi`, config.KASPI_PAY_URL)
    .row()
    .text("✅ Я оплатил(а)", "pay:claim");

  await bot.api.sendMessage(
    userId,
    `Стоимость подписки — ${price.toLocaleString("ru-RU")} ₸ на ${config.SUBSCRIPTION_DAYS} дней.\n\n1. Оплатите точную сумму по кнопке ниже.\n2. Вернитесь в бот и нажмите «Я оплатил(а)».\n3. Администратор сверит поступление в Kaspi Pay. Доступ выдаётся только после подтверждения реального платежа.`,
    { reply_markup: kb }
  );
}


async function showTributePayment(bot: Bot, userId: number) {
  const kb = new InlineKeyboard()
    .url("🌍 Перейти к оплате через Tribute", config.TRIBUTE_PAYMENT_URL)
    .row()
    .text("⬅️ Главное меню", "menu:home");

  await bot.api.sendMessage(
    userId,
    "Оплата для стран СНГ проводится через Tribute. Перед подтверждением платежа проверьте итоговую сумму: платёжный сервис, банк-эмитент или конвертация валюты могут применять дополнительную комиссию.",
    { reply_markup: kb }
  );
}

export function createBot() {
  const bot = new Bot(config.BOT_TOKEN);

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
    await ctx.reply(WELCOME, { reply_markup: mainMenu() });
  });

  bot.command("menu", async ctx => {
    await ctx.reply("Выберите нужный раздел:", { reply_markup: mainMenu() });
  });

  bot.callbackQuery("menu:pay", async ctx => {
    await ctx.answerCallbackQuery();
    const accepted = await hasConsent(ctx.from.id, CONSENT_VERSION);
    if (!accepted) {
      await ctx.reply(
        "Перед оплатой ознакомьтесь с документами. Нажимая кнопку подтверждения, вы фиксируете согласие с указанными условиями.",
        { reply_markup: documentsKeyboard("kaspi") }
      );
      return;
    }
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("menu:pay_cis", async ctx => {
    await ctx.answerCallbackQuery();
    const accepted = await hasConsent(ctx.from.id, CONSENT_VERSION);
    if (!accepted) {
      await ctx.reply(
        "Перед оплатой ознакомьтесь с документами. Нажимая кнопку подтверждения, вы фиксируете согласие с указанными условиями.",
        { reply_markup: documentsKeyboard("tribute") }
      );
      return;
    }
    await showTributePayment(bot, ctx.from.id);
  });

  bot.callbackQuery("menu:about", async ctx => {
    await ctx.answerCallbackQuery();
    const text = await getSetting("about_text", ABOUT);
    const freeUrl = await getSetting("free_channel_url", config.FREE_CHANNEL_URL ?? "");
    const kb = new InlineKeyboard();
    if (freeUrl) kb.url("🎁 Бесплатный канал", freeUrl).row();
    kb.text("💳 Оплатить доступ", "menu:pay").row().text("⬅️ Главное меню", "menu:home");
    await ctx.reply(text, { reply_markup: kb });
  });

  bot.callbackQuery("menu:trial", async ctx => {
    await ctx.answerCallbackQuery();
    const trialUrl = await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "");
    if (!trialUrl) {
      await ctx.reply("Пробный урок пока обновляется. Ссылка появится здесь после публикации.", { reply_markup: mainMenu() });
      return;
    }
    await ctx.reply("Пробный урок доступен по кнопке ниже:", {
      reply_markup: new InlineKeyboard()
        .url("▶️ Смотреть пробный урок", trialUrl)
        .row()
        .text("⬅️ Главное меню", "menu:home")
    });
  });

  bot.callbackQuery("menu:support", async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Служба поддержки: ${config.SUPPORT_PHONE}`,
      {
        reply_markup: new InlineKeyboard()
          .url("💬 Написать в поддержку", supportUrl())
          .row()
          .text("⬅️ Главное меню", "menu:home")
      }
    );
  });

  bot.callbackQuery("menu:home", async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply("Выберите нужный раздел:", { reply_markup: mainMenu() });
  });

  bot.hears("Подробнее о Bakieva Chat", async ctx => {
    const text = await getSetting("about_text", ABOUT);
    const freeUrl = await getSetting("free_channel_url", config.FREE_CHANNEL_URL ?? "");
    const kb = new InlineKeyboard();
    if (freeUrl) kb.url("🎁 Бесплатный канал", freeUrl).row();
    kb.text("💳 Оплатить подписку", "pay:start");
    await ctx.reply(text, { reply_markup: kb });
  });

  bot.hears("Что есть в чате?", async ctx => {
    const text = await getSetting("content_text", CONTENT);
    await ctx.reply(text, { reply_markup: mainMenu() });
  });

  bot.hears("Посмотреть пробный урок", async ctx => {
    const trialUrl = await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "");
    if (!trialUrl) {
      await ctx.reply("Пробный урок пока обновляется. Ссылка появится здесь после публикации.", { reply_markup: mainMenu() });
      return;
    }
    await ctx.reply("Пробный урок доступен по кнопке ниже:", {
      reply_markup: new InlineKeyboard().url("▶️ Смотреть пробный урок", trialUrl)
    });
  });

  bot.hears("Служба поддержки", async ctx => {
    await ctx.reply(
      `Служба поддержки: ${config.SUPPORT_PHONE}`,
      { reply_markup: new InlineKeyboard().url("💬 Написать в поддержку", supportUrl()) }
    );
  });

  bot.hears("Оплатить подписку", async ctx => {
    if (!ctx.from) return;
    const accepted = await hasConsent(ctx.from.id, CONSENT_VERSION);
    if (!accepted) {
      await ctx.reply(
        "Перед оплатой ознакомьтесь с документами. Нажимая кнопку подтверждения, вы фиксируете согласие с указанными условиями.",
        { reply_markup: documentsKeyboard("kaspi") }
      );
      return;
    }
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("pay:start", async ctx => {
    await ctx.answerCallbackQuery();
    const accepted = await hasConsent(ctx.from.id, CONSENT_VERSION);
    if (!accepted) {
      await ctx.reply("Перед оплатой необходимо принять документы.", { reply_markup: documentsKeyboard("kaspi") });
      return;
    }
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery(/^consent:accept:(kaspi|tribute)$/, async ctx => {
    await acceptConsent(ctx.from.id, CONSENT_VERSION);
    await ctx.answerCallbackQuery({ text: "Согласие сохранено" });
    if (ctx.match[1] === "tribute") {
      await showTributePayment(bot, ctx.from.id);
      return;
    }
    await showPayment(bot, ctx.from.id);
  });

  // Backward compatibility for consent buttons sent before this release.
  bot.callbackQuery("consent:accept", async ctx => {
    await acceptConsent(ctx.from.id, CONSENT_VERSION);
    await ctx.answerCallbackQuery({ text: "Согласие сохранено" });
    await showPayment(bot, ctx.from.id);
  });

  bot.callbackQuery("pay:claim", async ctx => {
    if (!ctx.from) return;
    const accepted = await hasConsent(ctx.from.id, CONSENT_VERSION);
    if (!accepted) {
      await ctx.answerCallbackQuery({ text: "Сначала подтвердите документы", show_alert: true });
      return;
    }

    const price = await getPrice();
    const paymentId = await createPendingPayment(ctx.from.id, price);
    await ctx.answerCallbackQuery({ text: "Заявка отправлена на проверку" });
    await ctx.reply("Проверяем поступление. Доступ не будет выдан, пока администратор не подтвердит реальный платёж в Kaspi Pay.");

    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
    const username = ctx.from.username ? `@${ctx.from.username}` : "без username";
    const adminKb = new InlineKeyboard()
      .text("✅ Подтвердить оплату", `pay:approve:${paymentId}`)
      .row()
      .text("❌ Отклонить", `pay:reject:${paymentId}`);

    for (const adminId of config.adminIds) {
      await bot.api.sendMessage(
        adminId,
        `Новая заявка на проверку оплаты #${paymentId}\nПользователь: ${name} (${username})\nTelegram ID: ${ctx.from.id}\nСумма: ${price.toLocaleString("ru-RU")} ₸\n\nПодтверждайте только после проверки фактического поступления в Kaspi Pay.`,
        { reply_markup: adminKb }
      );
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
