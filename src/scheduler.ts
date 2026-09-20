import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  dueForReminder,
  expiredSubscriptions,
  markExpired,
  markReminded
} from "./db.js";
import { removeAccess } from "./access.js";

async function run(bot: Bot) {
  const reminder = await dueForReminder();
  for (const sub of reminder) {
    try {
      const kb = new InlineKeyboard().text("💳 Продлить подписку", "pay:start");
      await bot.api.sendMessage(
        sub.userId,
        `⏳ До окончания подписки осталось не больше 3 дней. Доступ действует до ${sub.activeUntil.toLocaleDateString("ru-RU")}.\n\nЧтобы не потерять доступ, продлите подписку.`,
        { reply_markup: kb }
      );
      await markReminded(sub.userId);
    } catch (error) {
      console.error("Reminder failed", { userId: sub.userId, error });
    }
  }

  const expired = await expiredSubscriptions();
  for (const userId of expired) {
    await removeAccess(bot, userId);
    await markExpired(userId);
    try {
      const kb = new InlineKeyboard().text("Вернуться в Bakieva Chat", "pay:start");
      await bot.api.sendMessage(
        userId,
        "Срок подписки закончился, поэтому доступ к платным материалам закрыт. Вы можете вернуться в Bakieva Chat в любой момент.",
        { reply_markup: kb }
      );
    } catch (error) {
      console.error("Expiry message failed", { userId, error });
    }
  }
}

export function startScheduler(bot: Bot) {
  void run(bot);
  const timer = setInterval(() => void run(bot), 10 * 60 * 1000);
  timer.unref();
}
