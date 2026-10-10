import { Bot, GrammyError } from "grammy";
import type { Context } from "grammy";
import { config } from "./config.js";
import {
  createNewsPublication,
  getLatestNewsPublication,
  recordNewsDelivery,
  type NewsDelivery
} from "./db.js";

const DRAFT_TTL_MS = 10 * 60 * 1000;
const awaitingNews = new Map<number, number>();
const publishing = new Set<number>();

function adminInPrivate(ctx: Context): boolean {
  return ctx.from !== undefined &&
    config.adminIds.has(ctx.from.id) &&
    ctx.chat?.type === "private";
}

function newsTargets(): number[] {
  return [...new Set([
    config.paidChannelId,
    config.paidChatId,
    ...config.newsTargetChatIds
  ])].filter((id): id is number =>
    typeof id === "number" && Number.isSafeInteger(id) && id < 0
  );
}

function safeLabel(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").trim().slice(0, 120);
}

async function describeTarget(bot: Bot, chatId: number) {
  try {
    const chat = await bot.api.getChat(chatId);
    const username = "username" in chat && typeof chat.username === "string"
      ? chat.username
      : null;
    const title = "title" in chat && typeof chat.title === "string"
      ? chat.title
      : username ?? String(chatId);
    return { title: safeLabel(title), username };
  } catch {
    return { title: String(chatId), username: null };
  }
}

function postUrl(target: NewsDelivery): string | null {
  if (target.status !== "sent" || !target.messageId) return null;
  if (target.username) return `https://t.me/${target.username}/${target.messageId}`;
  const id = String(target.chatId);
  if (id.startsWith("-100")) {
    return `https://t.me/c/${id.slice(4)}/${target.messageId}`;
  }
  return null;
}

function formatError(error: unknown): string {
  const message = error instanceof GrammyError
    ? `Telegram ${error.error_code}: ${error.description}`
    : error instanceof Error ? error.message : String(error);
  return safeLabel(message).slice(0, 200) || "Неизвестная ошибка";
}

async function sendReport(ctx: Context, report: {
  id: number;
  createdAt: Date;
  deliveries: NewsDelivery[];
}) {
  const successes = report.deliveries.filter(item => item.status === "sent").length;
  const lines = [
    `📰 Отчёт о публикации #${report.id}`,
    `Дата: ${report.createdAt.toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })} (Алматы)`,
    `Опубликовано: ${successes}/${report.deliveries.length}`,
    ""
  ];

  for (const item of report.deliveries) {
    const name = `${safeLabel(item.title)} (ID: ${item.chatId})`;
    if (item.status === "sent") {
      lines.push(`✅ ${name}\nСообщение: #${item.messageId}`);
      const url = postUrl(item);
      if (url) lines.push(url);
    } else {
      lines.push(`❌ ${name}\nОшибка: ${safeLabel(item.error ?? "Причина неизвестна")}`);
    }
    lines.push("");
  }
  if (report.deliveries.length === 0) {
    lines.push("Получателей нет. Укажите ID групп и каналов в настройках.");
  }

  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length + 1 > 3800 && chunk) {
      await ctx.reply(chunk);
      chunk = "";
    }
    chunk += (chunk ? "\n" : "") + line;
  }
  if (chunk) await ctx.reply(chunk);
}

async function beginNews(ctx: Context) {
  if (!adminInPrivate(ctx)) return;
  if (publishing.has(ctx.from!.id)) {
    await ctx.reply("Предыдущая новость ещё публикуется. Дождитесь отчёта.");
    return;
  }
  const targets = newsTargets();
  if (!targets.length) {
    await ctx.reply("Нет настроенных групп или каналов. Укажите PAID_CHANNEL_ID, PAID_CHAT_ID либо NEWS_TARGET_CHAT_IDS в Railway.");
    return;
  }
  awaitingNews.set(ctx.from!.id, Date.now() + DRAFT_TTL_MS);
  await ctx.reply(
    `📰 Отправьте новость следующим сообщением. Она автоматически будет размещена в ${targets.length} подключённых группах/каналах.\n\nПоддерживается текст или одно сообщение с фото, видео, документом, аудио либо подписью. Альбомы отправляйте по одному сообщению.\n\nОтмена: /news_cancel. Ожидание — 10 минут.`
  );
}

function isSupportedNews(ctx: Context): boolean {
  const message = ctx.message;
  return Boolean(message && (
    "text" in message ||
    "photo" in message ||
    "video" in message ||
    "document" in message ||
    "animation" in message ||
    "audio" in message ||
    "voice" in message
  ));
}

export function installNewsHandlers(bot: Bot) {
  bot.command("news", beginNews);

  bot.callbackQuery("news:start", async ctx => {
    if (!adminInPrivate(ctx)) {
      await ctx.answerCallbackQuery({ text: "Только для администратора в личном чате", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await beginNews(ctx);
  });

  bot.command("news_cancel", async ctx => {
    if (!adminInPrivate(ctx)) return;
    awaitingNews.delete(ctx.from!.id);
    await ctx.reply("Подготовка новости отменена.");
  });

  bot.command("news_report", async ctx => {
    if (!adminInPrivate(ctx)) return;
    const report = await getLatestNewsPublication(ctx.from!.id);
    if (!report) {
      await ctx.reply("Отчётов о публикациях пока нет.");
      return;
    }
    await sendReport(ctx, report);
  });

  bot.on("message", async ctx => {
    if (!adminInPrivate(ctx)) return;
    const adminId = ctx.from!.id;
    const expiry = awaitingNews.get(adminId);
    if (!expiry) return;
    if (ctx.message.text?.startsWith("/")) return;
    if (Date.now() > expiry) {
      awaitingNews.delete(adminId);
      await ctx.reply("Время ожидания истекло. Нажмите «Опубликовать новость» ещё раз.");
      return;
    }
    if (ctx.message.media_group_id) {
      await ctx.reply("Альбом целиком не поддерживается. Отправьте новость одним сообщением с фото/видео и подписью.");
      return;
    }
    if (!isSupportedNews(ctx)) {
      await ctx.reply("Пришлите текст или одно сообщение с фото, видео, документом или аудио.");
      return;
    }
    if (publishing.has(adminId)) return;

    awaitingNews.delete(adminId);
    publishing.add(adminId);
    try {
      const publicationId = await createNewsPublication(adminId, ctx.chat.id, ctx.message.message_id);
      if (publicationId === null) {
        await ctx.reply("Эта новость уже была принята. Для проверки используйте /news_report.");
        return;
      }
      const targets = newsTargets();
      await ctx.reply(`📰 Начинаю публикацию #${publicationId} в ${targets.length} группах/каналах. После отправки пришлю отчёт.`);

      const deliveries: NewsDelivery[] = [];
      for (const chatId of targets) {
        const target = await describeTarget(bot, chatId);
        let delivery: NewsDelivery;
        try {
          const result = await bot.api.copyMessage(chatId, ctx.chat.id, ctx.message.message_id);
          delivery = {
            chatId,
            title: target.title,
            username: target.username,
            status: "sent",
            messageId: result.message_id,
            error: null
          };
        } catch (error) {
          delivery = {
            chatId,
            title: target.title,
            username: target.username,
            status: "failed",
            messageId: null,
            error: formatError(error)
          };
        }
        deliveries.push(delivery);
        try {
          await recordNewsDelivery(publicationId, delivery);
        } catch (error) {
          console.error("Failed to save news delivery audit", { publicationId, chatId, error });
          await ctx.reply(`⚠️ Не удалось сохранить результат доставки для ${chatId}, но отправка не повторялась. Проверьте отчёт выше и журнал сервера.`);
        }
      }
      await sendReport(ctx, { id: publicationId, createdAt: new Date(), deliveries });
    } catch (error) {
      console.error("News publishing failed", { adminId, error });
      await ctx.reply(`Не удалось завершить публикацию: ${formatError(error)}. Проверьте /news_report — повторная публикация может создать дубликаты.`);
    } finally {
      publishing.delete(adminId);
    }
  });
}
