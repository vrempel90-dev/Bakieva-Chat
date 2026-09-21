import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getPaidChannelId, getPaidChatId, getUserLanguage } from "./db.js";
import { TEXTS, dateForLocale } from "./i18n.js";

export async function sendAccess(bot: Bot, userId: number, activeUntil: Date) {
  const [paidChannelId, paidChatId, storedLanguage] = await Promise.all([
    getPaidChannelId(),
    getPaidChatId(),
    getUserLanguage(userId)
  ]);
  const language = storedLanguage ?? "ru";
  const t = TEXTS[language];
  if (!paidChannelId || !paidChatId) {
    throw new Error("Paid channel/chat are not bound");
  }

  const expireDate = Math.floor(Date.now() / 1000) + 60 * 60;
  const [channel, chat] = await Promise.all([
    bot.api.createChatInviteLink(paidChannelId, {
      expire_date: expireDate,
      member_limit: 1,
      name: `Bakieva paid ${userId}`
    }),
    bot.api.createChatInviteLink(paidChatId, {
      expire_date: expireDate,
      member_limit: 1,
      name: `Bakieva paid ${userId}`
    })
  ]);

  const keyboard = new InlineKeyboard()
    .url(t.accessChannel, channel.invite_link)
    .row()
    .url(t.accessChat, chat.invite_link);

  await bot.api.sendMessage(
    userId,
    t.accessGranted(dateForLocale(activeUntil, language)),
    { reply_markup: keyboard }
  );
}

export async function removeAccess(bot: Bot, userId: number) {
  const [paidChannelId, paidChatId] = await Promise.all([
    getPaidChannelId(),
    getPaidChatId()
  ]);
  for (const chatId of [paidChannelId, paidChatId].filter(id => id !== 0)) {
    try {
      await bot.api.banChatMember(chatId, userId);
      await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
    } catch (error) {
      console.error("Failed to remove member", { chatId, userId, error });
    }
  }
}
