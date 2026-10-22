import { Bot, GrammyError, InlineKeyboard, Keyboard } from "grammy";
import { config } from "./config.js";
import {
  ensureUser,
  getMarketingUsers,
  getSetting,
  setMarketing,
  setSetting,
} from "./db.js";
import { ABOUT, CONTENT, WELCOME } from "./texts.js";
import { installNewsHandlers } from "./news.js";
import { installMembershipHandlers } from "./membership.js";
import {
  continuePurchase,
  installPurchaseHandlers,
} from "./purchase-handlers.js";
import { installAdminHandlers } from "./admin.js";
import { anonymizeBuyer } from "./privacy.js";
import { UserError } from "./errors.js";

const menu = new Keyboard()
  .text("Оплатить подписку")
  .row()
  .text("Подробнее о Bakieva Chat")
  .row()
  .text("Что есть в чате?")
  .row()
  .text("Посмотреть пробный урок")
  .row()
  .text("Служба поддержки")
  .resized();
export function createBot() {
  const bot = new Bot(config.BOT_TOKEN, { client: { timeoutSeconds: 25 } });
  bot.use(async (ctx, next) => {
    // Personal and administrative interactions must stay in a private bot dialog.
    if (
      ctx.chat?.type !== "private" &&
      (ctx.message?.text || ctx.callbackQuery)
    )
      return;
    if (ctx.chat?.type === "private" && ctx.from) await ensureUser(ctx.from);
    try {
      await next();
    } catch (error) {
      console.warn("Update failed", {
        updateId: ctx.update.update_id,
        kind: error instanceof Error ? error.name : "unknown",
        telegramCode:
          error instanceof GrammyError ? error.error_code : undefined,
      });
      if (ctx.chat?.type === "private") {
        try {
          await ctx.reply(
            error instanceof UserError
              ? error.message
              : "Не удалось завершить действие. Сохранённое состояние не потеряно. Попробуйте /access или /admin; при повторной ошибке обратитесь в поддержку.",
          );
        } catch {
          /* User may have blocked the bot. */
        }
      }
    }
  });
  bot.command("start", async (ctx) => {
    await ctx.reply(WELCOME, { reply_markup: menu });
    await continuePurchase(bot, ctx.from!.id);
  });
  bot.command("menu", (ctx) =>
    ctx.reply("Выберите раздел:", { reply_markup: menu }),
  );
  bot.hears("Подробнее о Bakieva Chat", async (ctx) => {
    const kb = new InlineKeyboard();
    const free = await getSetting(
      "free_channel_url",
      config.FREE_CHANNEL_URL ?? "",
    );
    if (free) kb.url("🎁 Бесплатный канал", free).row();
    kb.text("💳 Оплатить подписку", "pay:start");
    await ctx.reply(await getSetting("about_text", ABOUT), {
      reply_markup: kb,
    });
  });
  bot.hears("Что есть в чате?", async (ctx) => {
    await ctx.reply(await getSetting("content_text", CONTENT), {
      reply_markup: menu,
    });
  });
  bot.hears("Посмотреть пробный урок", async (ctx) => {
    const url = await getSetting("trial_url", config.TRIAL_LESSON_URL ?? "");
    if (!url) {
      await ctx.reply("Пробный урок пока обновляется.");
      return;
    }
    await ctx.reply("Пробный урок:", {
      reply_markup: new InlineKeyboard().url("▶️ Смотреть", url),
    });
  });
  bot.hears("Служба поддержки", (ctx) =>
    ctx.reply(`Служба поддержки: ${config.SUPPORT_PHONE}`, {
      reply_markup: new InlineKeyboard().url(
        "Написать в поддержку",
        `tg://resolve?phone=${config.SUPPORT_PHONE.replace(/\D/g, "")}`,
      ),
    }),
  );
  bot.command("subscribe", async (ctx) => {
    await setMarketing(ctx.from!.id, true);
    await ctx.reply(
      "Добровольное согласие на информационные и рекламные сообщения сохранено. Отказаться: /unsubscribe.",
    );
  });
  bot.command("unsubscribe", async (ctx) => {
    await setMarketing(ctx.from!.id, false);
    await ctx.reply("Маркетинговая рассылка отключена.");
  });
  bot.callbackQuery("marketing:off", async (ctx) => {
    await setMarketing(ctx.from.id, false);
    await ctx.answerCallbackQuery({ text: "Рассылка отключена" });
  });
  bot.command("delete_data", (ctx) =>
    ctx.reply(
      "Обезличить покупки, удалить WhatsApp, согласия и данные профиля? Доступ будет закрыт. История сумм и тарифов останется без привязки к вам. Для удаления ранее выгруженных файлов обратитесь в поддержку.",
      {
        reply_markup: new InlineKeyboard().text(
          "Удалить мои данные и закрыть доступ",
          "privacy:delete",
        ),
      },
    ),
  );
  bot.callbackQuery("privacy:delete", async (ctx) => {
    await ctx.answerCallbackQuery();
    await anonymizeBuyer(bot, ctx.from.id);
    await ctx.reply(
      "Профиль удалён, покупки обезличены. Ранее отправленные отчёты и выгруженные файлы удаляются владельцем по запросу через поддержку.",
    );
  });
  bot.command("set", async (ctx) => {
    if (!config.adminIds.has(ctx.from!.id)) return;
    const body = ctx.match.trim();
    const space = body.indexOf(" ");
    const key = body.slice(0, space);
    const value = body.slice(space + 1).trim();
    const keys: Record<string, string> = {
      about: "about_text",
      content: "content_text",
      trial_url: "trial_url",
      free_channel_url: "free_channel_url",
    };
    if (space < 1 || !keys[key] || !value)
      throw new UserError(
        "Формат: /set about текст | content текст | trial_url https://... | free_channel_url https://...",
      );
    if (key.endsWith("_url")) {
      try {
        if (new URL(value).protocol !== "https:") throw new Error();
      } catch {
        throw new UserError("Нужна корректная ссылка https://");
      }
    }
    await setSetting(keys[key], value);
    await ctx.reply("Настройка сохранена.");
  });
  bot.command("broadcast", async (ctx) => {
    if (!config.adminIds.has(ctx.from!.id)) return;
    const text = ctx.match.trim();
    if (!text) throw new UserError("Формат: /broadcast текст");
    const users = await getMarketingUsers();
    let sent = 0;
    for (const user of users) {
      try {
        await bot.api.sendMessage(user, text, {
          reply_markup: new InlineKeyboard().text(
            "Отписаться",
            "marketing:off",
          ),
        });
        sent++;
      } catch {
        /* Continue other recipients. */
      }
    }
    await ctx.reply(`Рассылка завершена: ${sent}/${users.length}.`);
  });
  installMembershipHandlers(bot);
  installAdminHandlers(bot);
  installNewsHandlers(bot);
  installPurchaseHandlers(bot);
  bot.catch(() => console.warn("Unhandled bot update failure"));
  return bot;
}
