import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { config, CONSENT_VERSION } from "./config.js";
import { acceptConsent, hasConsent, pool } from "./db.js";
import {
  acceptDataConsent,
  approvePayment,
  cancelPayment,
  claimPayment,
  confirmPhone,
  getPlans,
  profile,
  proposePhone,
  rejectPayment,
  requestPhone,
  resumePurchase,
  selectPlan,
} from "./commerce.js";
import { sendAccess, handleJoin } from "./access.js";
import { UserError } from "./errors.js";

function legalKeyboard() {
  const kb = new InlineKeyboard();
  for (const [label, url] of [
    ["Оферта", config.OFFER_URL],
    ["Политика конфиденциальности", config.PRIVACY_URL],
    ["Обработка данных", config.DATA_CONSENT_URL],
    ["Подписка и возврат", config.SUBSCRIPTION_TERMS_URL],
  ]) {
    if (url) kb.url(label!, url).row();
  }
  return kb.text("Принимаю условия", "consent:accept");
}
export async function showPlans(bot: Bot, userId: number) {
  if (!(await hasConsent(userId, CONSENT_VERSION))) {
    if (
      !config.OFFER_URL ||
      !config.PRIVACY_URL ||
      !config.DATA_CONSENT_URL ||
      !config.SUBSCRIPTION_TERMS_URL
    ) {
      await bot.api.sendMessage(
        userId,
        "Документы пока не настроены. Обратитесь в поддержку.",
      );
      return;
    }
    await bot.api.sendMessage(
      userId,
      "Ознакомьтесь с документами и подтвердите условия перед выбором тарифа.",
      { reply_markup: legalKeyboard() },
    );
    return;
  }
  const plans = await getPlans();
  const kb = new InlineKeyboard();
  for (const p of plans)
    kb.text(
      `${p.name} — ${p.price.toLocaleString("ru-RU")} ₸`,
      `plan:${p.id}`,
    ).row();
  await bot.api.sendMessage(userId, "Выберите тариф:", { reply_markup: kb });
}
async function paymentCard(bot: Bot, userId: number, p: any) {
  if (p.legacy) {
    await bot.api.sendMessage(
      userId,
      `У вас есть архивная заявка #${p.id}. Обратитесь в поддержку для уточнения тарифа.`,
    );
    return;
  }
  if (p.status !== "pending") {
    await continuePurchase(bot, userId);
    return;
  }
  const kb = new InlineKeyboard()
    .url(
      `Оплатить ${p.amount.toLocaleString("ru-RU")} ₸ через Kaspi`,
      config.KASPI_PAY_URL,
    )
    .row()
    .text("✅ Я оплатил(а)", `pay:claim:${p.id}`);
  if (!p.claimed_at)
    kb.row().text("Отменить неоплаченную заявку", `pay:cancel:${p.id}`);
  await bot.api.sendMessage(
    userId,
    `Заявка #${p.id}: ${p.plan_name}, ${p.amount.toLocaleString("ru-RU")} ₸.
Оплатите точную сумму и нажмите «Я оплатил(а)». Администратор проверит реальное поступление в Kaspi Pay.
После подтверждения потребуются ваш WhatsApp и согласие на обработку данных. Срок начнётся после выполнения этих условий.`,
    { reply_markup: kb },
  );
}
export async function continuePurchase(bot: Bot, userId: number) {
  await resumePurchase(userId);
  const u = await profile(userId);
  if (!u?.paid) {
    const p = (
      await pool.query(
        "SELECT * FROM payments WHERE user_id=$1 AND status='pending' ORDER BY id DESC LIMIT 1",
        [userId],
      )
    ).rows[0];
    if (p) {
      await paymentCard(bot, userId, p);
      return;
    }
    await bot.api.sendMessage(
      userId,
      "Подтверждённых оплат пока нет. Выберите тариф через меню.",
    );
    return;
  }
  if (!u.data_consent_at) {
    if (!config.DATA_CONSENT_URL || !config.PRIVACY_URL) {
      await bot.api.sendMessage(
        userId,
        "Согласие на обработку данных пока не настроено. Обратитесь в поддержку.",
      );
      return;
    }
    await bot.api.sendMessage(
      userId,
      `✅ Оплата подтверждена и сохранена.
Для доступа нужен ваш WhatsApp. Он используется для учёта покупателей и связи по подписке. Мы проверяем структуру номера, но не регистрацию в WhatsApp. Маркетинг добровольный и по умолчанию отключён.`,
      {
        reply_markup: new InlineKeyboard()
          .url("Политика конфиденциальности", config.PRIVACY_URL)
          .row()
          .url("Согласие на обработку данных", config.DATA_CONSENT_URL)
          .row()
          .text("Согласен(на) на обработку данных", "data:accept"),
      },
    );
    return;
  }
  if (
    !u.whatsapp ||
    u.profile_state === "awaiting_phone" ||
    u.profile_state === "confirm_phone"
  ) {
    if (u.profile_state === "confirm_phone" && u.phone_candidate) {
      await bot.api.sendMessage(
        userId,
        `Подтвердите свой WhatsApp: ${u.phone_candidate}`,
        {
          reply_markup: new InlineKeyboard()
            .text("Это мой номер", `phone:confirm:${u.phone_token}`)
            .row()
            .text("Исправить", "phone:edit"),
        },
      );
      return;
    }
    await requestPhone(userId);
    await bot.api.sendMessage(
      userId,
      "Укажите свой WhatsApp в международном формате, например +7 701 123 45 67, или поделитесь собственным контактом. Регистрация в WhatsApp технически не проверяется.",
      {
        reply_markup: new Keyboard()
          .requestContact("Поделиться контактом")
          .resized()
          .oneTime(),
      },
    );
    return;
  }
  if (!(await sendAccess(bot, userId))) {
    await bot.api.sendMessage(
      userId,
      "Оплата сохранена. Сейчас подписка не активна. Для продления выберите тариф через меню.",
    );
    return;
  }
  await bot.api.sendMessage(
    userId,
    `WhatsApp сохранён. Изменить: /whatsapp. Маркетинговая рассылка: ${u.marketing_opt_in ? "включена" : "отключена"}.
Добровольно подписаться: /subscribe; отказаться: /unsubscribe.`,
    { reply_markup: { remove_keyboard: true } },
  );
}
export async function notifyPayment(bot: Bot, p: any) {
  const kb = new InlineKeyboard()
    .text("✅ Проверил(а) Kaspi: подтвердить", `pay:approve:${p.id}`)
    .row()
    .text("❌ Отклонить", `pay:reject:${p.id}`);
  for (const admin of config.adminIds) {
    try {
      await bot.api.sendMessage(
        admin,
        `Проверка оплаты #${p.id}
${p.buyer_name ?? "Без имени"} ${p.buyer_username ? "@" + p.buyer_username : ""}; Telegram ID: ${p.user_id}
Тариф: ${p.plan_name}; сумма: ${p.amount} ₸; срок: ${p.plan_days ?? "неизвестно"} дней.
Подтвердите только после сверки реального поступления в Kaspi Pay.`,
        { reply_markup: kb },
      );
    } catch {
      console.warn("Payment admin notification failed", {
        paymentId: p.id,
        admin,
      });
    }
  }
}
export function adminPrivate(ctx: Context) {
  return (
    ctx.chat?.type === "private" &&
    !!ctx.from &&
    config.adminIds.has(ctx.from.id)
  );
}
export function installPurchaseHandlers(bot: Bot) {
  bot.on("chat_join_request", (ctx) =>
    handleJoin(
      bot,
      ctx.chatJoinRequest.from.id,
      ctx.chatJoinRequest.chat.id,
      ctx.chatJoinRequest.invite_link?.invite_link,
    ),
  );
  bot.hears("Оплатить подписку", (ctx) => showPlans(bot, ctx.from!.id));
  bot.callbackQuery("pay:start", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPlans(bot, ctx.from.id);
  });
  bot.callbackQuery("consent:accept", async (ctx) => {
    if (
      !config.OFFER_URL ||
      !config.PRIVACY_URL ||
      !config.DATA_CONSENT_URL ||
      !config.SUBSCRIPTION_TERMS_URL
    )
      return;
    await acceptConsent(ctx.from.id, CONSENT_VERSION);
    await ctx.answerCallbackQuery();
    await showPlans(bot, ctx.from.id);
  });
  bot.callbackQuery(/^plan:(month|half_year)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await hasConsent(ctx.from.id, CONSENT_VERSION))) {
      await showPlans(bot, ctx.from.id);
      return;
    }
    await paymentCard(
      bot,
      ctx.from.id,
      await selectPlan(ctx.from.id, ctx.match[1], ctx.update.update_id),
    );
  });
  bot.callbackQuery(/^pay:cancel:(\d+)$/, async (ctx) => {
    const cancelled = await cancelPayment(ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({
      text: cancelled
        ? "Неоплаченная заявка отменена"
        : "Заявка уже на проверке или обработана",
    });
    await showPlans(bot, ctx.from.id);
  });
  bot.callbackQuery(/^pay:claim(?::(\d+))?$/, async (ctx) => {
    if (!(await hasConsent(ctx.from.id, CONSENT_VERSION))) {
      await ctx.answerCallbackQuery();
      await showPlans(bot, ctx.from.id);
      return;
    }
    const id = Number(ctx.match[1]);
    if (!id) {
      await ctx.answerCallbackQuery();
      await showPlans(bot, ctx.from.id);
      return;
    }
    const p = await claimPayment(ctx.from.id, id);
    await ctx.answerCallbackQuery({
      text: p
        ? "Заявка сохранена"
        : "Заявка уже обработана или принадлежит другому аккаунту",
    });
    if (!p) return;
    await ctx.reply(
      "Проверяем реальное поступление в Kaspi Pay. Доступ пока закрыт. Состояние заявки сохраняется при перезапуске.",
    );
    await notifyPayment(bot, p);
  });
  bot.callbackQuery(/^pay:approve:(\d+)$/, async (ctx) => {
    if (!adminPrivate(ctx)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const id = Number(ctx.match[1]);
    const approved = await approvePayment(id, ctx.from.id);
    await ctx.answerCallbackQuery({
      text: approved ? "Оплата подтверждена" : "Заявка уже обработана",
    });
    if (approved) {
      await ctx.editMessageText(
        `✅ Оплата #${id} подтверждена. Обязательные условия доступа проверяются отдельно.`,
      );
      try {
        await continuePurchase(bot, approved.userId);
      } catch {
        await ctx.reply(
          "Оплата сохранена. Не удалось отправить клиенту следующий шаг. Клиент может продолжить через /access или /start.",
        );
      }
    }
  });
  bot.callbackQuery(/^pay:reject:(\d+)$/, async (ctx) => {
    if (!adminPrivate(ctx)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const userId = await rejectPayment(Number(ctx.match[1]), ctx.from.id);
    await ctx.answerCallbackQuery({
      text: userId ? "Заявка отклонена" : "Заявка уже обработана",
    });
    if (userId) {
      await ctx.editMessageText("❌ Заявка отклонена.");
      try {
        await bot.api.sendMessage(
          userId,
          "Платёж не найден или сумма не совпала. Если вы оплатили, обратитесь в поддержку.",
        );
      } catch {
        /* Rejection is committed. */
      }
    }
  });
  bot.command("access", (ctx) => continuePurchase(bot, ctx.from!.id));
  bot.command("whatsapp", async (ctx) => {
    const u = await profile(ctx.from!.id);
    if (u?.paid && u.data_consent_at) await requestPhone(ctx.from!.id);
    await continuePurchase(bot, ctx.from!.id);
  });
  bot.callbackQuery("data:accept", async (ctx) => {
    if (!config.DATA_CONSENT_URL || !config.PRIVACY_URL) return;
    if (!(await profile(ctx.from.id))?.paid) {
      await ctx.answerCallbackQuery({ text: "Сначала подтверждение оплаты" });
      return;
    }
    await acceptDataConsent(ctx.from.id);
    await ctx.answerCallbackQuery();
    await continuePurchase(bot, ctx.from.id);
  });
  bot.callbackQuery("phone:edit", async (ctx) => {
    await requestPhone(ctx.from.id);
    await ctx.answerCallbackQuery();
    await continuePurchase(bot, ctx.from.id);
  });
  bot.callbackQuery(/^phone:confirm:([a-f0-9-]+)$/, async (ctx) => {
    const saved = await confirmPhone(ctx.from.id, ctx.match[1]);
    await ctx.answerCallbackQuery({
      text: saved
        ? "Номер сохранён"
        : "Подтверждение устарело. Откройте /whatsapp",
    });
    if (saved) await continuePurchase(bot, ctx.from.id);
  });
  const phoneMessage = async (ctx: Context, next: () => Promise<void>) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return next();
    const u = await profile(ctx.from.id);
    if (!u || !["awaiting_phone", "confirm_phone"].includes(u.profile_state))
      return next();
    if (ctx.message?.text?.startsWith("/")) return next();
    const contact = ctx.message?.contact;
    const input = contact?.phone_number ?? ctx.message?.text;
    if (!input) return next();
    let candidate;
    try {
      candidate = await proposePhone(
        ctx.from.id,
        input,
        contact?.user_id,
        !!contact,
      );
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      await ctx.reply(error.message);
      return;
    }
    await ctx.reply(
      `Проверьте WhatsApp: ${candidate.phone}. Подтверждая, вы указываете, что номер принадлежит вам.`,
      {
        reply_markup: new InlineKeyboard()
          .text("Это мой номер", `phone:confirm:${candidate.token}`)
          .row()
          .text("Исправить", "phone:edit"),
      },
    );
  };
  bot.on(["message:text", "message:contact"], phoneMessage);
}
