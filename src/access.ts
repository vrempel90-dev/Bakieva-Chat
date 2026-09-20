import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";

export async function sendAccess(bot: Bot, userId: number, activeUntil: Date) {
  const expireDate = Math.floor(Date.now() / 1000) + 60 * 60;
  const [channel, chat] = await Promise.all([
    bot.api.createChatInviteLink(config.paidChannelId, {
      expire_date: expireDate,
      member_limit: 1,
      name: `Bakieva paid ${userId}`
    }),
    bot.api.createChatInviteLink(config.paidChatId, {
      expire_date: expireDate,
      member_limit: 1,
      name: `Bakieva paid ${userId}`
    })
  ]);

  const keyboard = new InlineKeyboard()
    .url("📚 Вступить в закрытый канал", channel.invite_link)
    .row()
    .url("💬 Вступить в закрытый чат", chat.invite_link);

  await bot.api.sendMessage(
    userId,
    `✅ Оплата подтверждена. Доступ активен до ${activeUntil.toLocaleDateString("ru-RU")} включительно.\n\nСсылки действуют 1 час. После перехода отправьте заявку на вступление — бот одобрит её только для аккаунта с активной подпиской.`,
    { reply_markup: keyboard }
  );
}

export async function removeAccess(bot: Bot, userId: number) {
  for (const chatId of [config.paidChannelId, config.paidChatId]) {
    try {
      await bot.api.banChatMember(chatId, userId);
      await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
    } catch (error) {
      console.error("Failed to remove member", { chatId, userId, error });
    }
  }
}
