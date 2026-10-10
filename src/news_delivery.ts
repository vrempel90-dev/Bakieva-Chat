import type { Bot } from "grammy";
import { GrammyError } from "grammy";
import { config } from "./config.js";
import {
  getPaidChannelId,
  getPaidChatId,
  getPaidMainChatId,
  recordContentNewsDelivery,
  type NewsGroupDelivery
} from "./db.js";

export type NewsForGroups = {
  id: number;
  body: string | null;
  telegramFileId: string | null;
  telegramMediaType: string | null;
};

function clean(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").trim().slice(0, 180);
}

export function deduplicateNewsTargets(ids: number[]): number[] {
  return [...new Set(ids)].filter(id => Number.isSafeInteger(id) && id < 0);
}

export async function resolveNewsTargets(): Promise<number[]> {
  return deduplicateNewsTargets([
    await getPaidChannelId(),
    await getPaidChatId(),
    await getPaidMainChatId(),
    ...config.newsTargetChatIds
  ]);
}

export function newsMessageLink(item: NewsGroupDelivery): string | null {
  if (!item.messageId) return null;
  if (item.username) return `https://t.me/${item.username}/${item.messageId}`;
  const id = String(item.chatId);
  return id.startsWith("-100") ? `https://t.me/c/${id.slice(4)}/${item.messageId}` : null;
}

export function formatGroupDeliveryReport(postId: number, deliveries: NewsGroupDelivery[]): string {
  const successful = deliveries.filter(d => d.status === "sent").length;
  const result = [
    `📊 Отчёт о новости #${postId}`,
    `Группы и каналы: успешно ${successful} из ${deliveries.length}`,
    ""
  ];
  if (!deliveries.length) result.push("Нет настроенных групп/каналов.");
  for (const item of deliveries) {
    const marker = item.status === "sent" ? "✅" : item.status === "partial" ? "⚠️" : "❌";
    result.push(`${marker} ${clean(item.title)} (ID: ${item.chatId})`);
    if (item.messageId) result.push(`Telegram message ID: ${item.messageId}`);
    const link = newsMessageLink(item);
    if (link) result.push(link);
    if (item.error) result.push(`Причина: ${clean(item.error)}`);
    result.push("");
  }
  return result.join("\n");
}

async function describe(bot: Bot, chatId: number) {
  try {
    const chat = await bot.api.getChat(chatId);
    const username = "username" in chat && typeof chat.username === "string"
      ? chat.username : null;
    const title = "title" in chat && typeof chat.title === "string"
      ? chat.title : username ?? `Чат ${chatId}`;
    return { title: clean(title), username };
  } catch {
    return { title: `Чат ${chatId}`, username: null };
  }
}

function errorDescription(error: unknown): string {
  return clean(error instanceof GrammyError
    ? `Telegram ${error.error_code}: ${error.description}`
    : error instanceof Error ? error.message : String(error));
}

function segments(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    parts.push(text.slice(start, start + size));
  }
  return parts;
}

class PartialSendError extends Error {
  constructor(readonly firstMessageId: number, readonly deliveryCause: unknown) {
    super("The first Telegram message was sent, but a later part failed");
  }
}

async function sendNewsToChat(bot: Bot, chatId: number, news: NewsForGroups): Promise<number> {
  const body = news.body?.trim() ?? "";
  if (news.telegramFileId && ["photo", "video", "document"].includes(news.telegramMediaType ?? "")) {
    const caption = body.slice(0, 1000);
    const options = caption ? { caption } : {};
    let messageId: number;
    switch (news.telegramMediaType) {
      case "photo":
        messageId = (await bot.api.sendPhoto(chatId, news.telegramFileId, options)).message_id;
        break;
      case "video":
        messageId = (await bot.api.sendVideo(chatId, news.telegramFileId, options)).message_id;
        break;
      default:
        messageId = (await bot.api.sendDocument(chatId, news.telegramFileId, options)).message_id;
    }
    try {
      for (const part of segments(body.slice(1000), 3900)) {
        await bot.api.sendMessage(chatId, part);
      }
    } catch (error) {
      throw new PartialSendError(messageId, error);
    }
    return messageId;
  }
  const parts = segments(body, 3900);
  if (parts.length === 0) throw new Error("Текст новости пуст, файл не приложен");
  let firstMessageId: number | null = null;
  try {
    for (const part of parts) {
      const message = await bot.api.sendMessage(chatId, part);
      firstMessageId ??= message.message_id;
    }
  } catch (error) {
    if (firstMessageId !== null) throw new PartialSendError(firstMessageId, error);
    throw error;
  }
  return firstMessageId!;
}

export async function publishNewsToGroups(
  bot: Bot,
  news: NewsForGroups,
  targets: number[]
): Promise<NewsGroupDelivery[]> {
  const deliveries: NewsGroupDelivery[] = [];
  for (const chatId of deduplicateNewsTargets(targets)) {
    const { title, username } = await describe(bot, chatId);
    let messageId: number | null = null;
    let status: NewsGroupDelivery["status"] = "failed";
    let errorText: string | null = null;
    try {
      messageId = await sendNewsToChat(bot, chatId, news);
      status = "sent";
    } catch (error) {
      if (error instanceof PartialSendError) {
        status = "partial";
        messageId = error.firstMessageId;
        errorText = errorDescription(error.deliveryCause);
      } else {
        status = "failed";
        errorText = errorDescription(error);
      }
    }
    const item: NewsGroupDelivery = {
      chatId, title, username, status, messageId, error: errorText
    };
    deliveries.push(item);
    try {
      await recordContentNewsDelivery(news.id, item);
    } catch (error) {
      console.error("Could not persist news delivery result", { postId: news.id, chatId, error });
    }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  return deliveries;
}
