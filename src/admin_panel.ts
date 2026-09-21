import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminStatsForDays,
  createContentDraft,
  deleteContentPost,
  getActiveNotificationUsers,
  getContentPost,
  getLegacyMembers,
  getMarketingUsers,
  getPrice,
  getPaidChannelId,
  getPaidChatId,
  getUserLanguage,
  legacyStats,
  listContentPosts,
  markContentNotified,
  publishContentPost,
  registerLegacyMember,
  registerLegacyMembers,
  setPaidChannelId,
  setPaidChatId,
  setSetting,
  LEGACY_EXPIRES_AT
} from "./db.js";
import { formatAdminReport } from "./admin_reports.js";
import { TEXTS, dateForLocale } from "./i18n.js";

type AdminState =
  | { mode: "video" }
  | { mode: "news" }
  | { mode: "legacy_import" };

const adminStates = new Map<number, AdminState>();

function isAdmin(id?: number) {
  return typeof id === "number" && config.adminIds.has(id);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function adminHomeKeyboard() {
  return new InlineKeyboard()
    .text("📊 Статистика", "panel:stats:1")
    .text("💰 Цена", "panel:price")
    .row()
    .text("🎬 Загрузить видео", "panel:new:video")
    .text("📰 Добавить новость", "panel:new:news")
    .row()
    .text("📚 Материалы", "panel:content:list")
    .row()
    .text("👥 Подписки до 12 октября", "panel:legacy")
    .row()
    .text("⚙️ Привязать чат и канал", "panel:targets");
}

function publishKeyboard(id: number) {
  return new InlineKeyboard()
    .text("📣 Всем пользователям", `content:pub:all:${id}`)
    .row()
    .text("⭐ Только активным подписчикам", `content:pub:active:${id}`)
    .row()
    .text("🗑 Удалить черновик", `content:del:${id}`)
    .text("🏠 Админка", "panel:home");
}

function contentTypeLabel(kind: "video" | "news") {
  return kind === "video" ? "🎬 Видео" : "📰 Новость";
}

function contentStatusLabel(status: "draft" | "published" | "deleted") {
  if (status === "draft") return "черновик";
  if (status === "published") return "опубликовано";
  return "удалено";
}

function adminPeriodLabel(days: number) {
  if (days === 1) return "сегодня";
  if (days === 7) return "за 7 дней";
  return "за 30 дней";
}

async function showAdminHome(bot: Bot, userId: number) {
  const s = await adminStatsForDays(1);
  const price = await getPrice();
  const text = [
    "🛠 Админ-панель Bakieva Chat",
    "",
    `Цена подписки: ${price.toLocaleString("ru-RU")} ₸`,
    `Новых пользователей сегодня: ${s.newUsers}`,
    `Активных подписок: ${s.activeSubscriptions}`,
    `Оплат сегодня: ${s.payments}`,
    `Выручка сегодня: ${s.revenue.toLocaleString("ru-RU")} ₸`,
    "",
    "Выберите действие:"
  ].join("\n");

  await bot.api.sendMessage(userId, text, { reply_markup: adminHomeKeyboard() });
}

async function showContentList(bot: Bot, userId: number) {
  const posts = await listContentPosts(10);
  if (posts.length === 0) {
    await bot.api.sendMessage(userId, "Материалов пока нет.", {
      reply_markup: new InlineKeyboard()
        .text("🎬 Загрузить видео", "panel:new:video")
        .text("📰 Новость", "panel:new:news")
        .row()
        .text("🏠 Админка", "panel:home")
    });
    return;
  }

  const lines = ["📚 Последние материалы", ""];
  const kb = new InlineKeyboard();
  for (const post of posts) {
    const label = post.title || (post.body?.split("\n")[0] ?? "");
    lines.push(
      `#${post.id} · ${contentTypeLabel(post.kind)} · ${contentStatusLabel(post.status)}` +
      (label ? `\n${label.slice(0, 80)}` : "") +
      (post.status === "published" ? `\nУведомлено: ${post.notifiedCount}` : "")
    );
    lines.push("");
    if (post.status === "draft") {
      kb.text(`📤 #${post.id}`, `content:open:${post.id}`)
        .text(`🗑 #${post.id}`, `content:del:${post.id}`)
        .row();
    } else {
      kb.text(`🗑 #${post.id}`, `content:del:${post.id}`).row();
    }
  }
  kb.text("🏠 Админка", "panel:home");

  await bot.api.sendMessage(userId, lines.join("\n"), { reply_markup: kb });
}

async function showDraft(bot: Bot, userId: number, postId: number) {
  const post = await getContentPost(postId);
  if (!post || post.status !== "draft") {
    await bot.api.sendMessage(userId, "Черновик не найден или уже опубликован.");
    return;
  }

  if (post.kind === "video" && post.telegramFileId) {
    await bot.api.sendVideo(userId, post.telegramFileId, {
      caption: post.body?.slice(0, 1000) || "Предпросмотр видео",
      reply_markup: publishKeyboard(post.id)
    });
    return;
  }

  await bot.api.sendMessage(
    userId,
    `📰 Предпросмотр новости\n\n${post.body ?? ""}`,
    { reply_markup: publishKeyboard(post.id) }
  );
}

async function deliverContent(
  bot: Bot,
  postId: number,
  audience: "all" | "active"
) {
  const draft = await getContentPost(postId);
  if (!draft || draft.status !== "draft") {
    return { ok: false as const, reason: "not_draft" as const };
  }

  const published = await publishContentPost(postId, audience);
  if (!published) return { ok: false as const, reason: "not_draft" as const };

  const userIds = audience === "active"
    ? await getActiveNotificationUsers()
    : await getMarketingUsers();

  let sent = 0;
  for (const userId of userIds) {
    try {
      const language = (await getUserLanguage(userId)) ?? "ru";
      const t = TEXTS[language];
      if (published.kind === "video" && published.telegramFileId) {
        const caption = [
          t.newVideo,
          published.body?.trim() ?? ""
        ].filter(Boolean).join("\n\n").slice(0, 1000);
        await bot.api.sendVideo(userId, published.telegramFileId, {
          caption,
          reply_markup: new InlineKeyboard().text(
            t.unsubscribe,
            "marketing:off"
          )
        });
      } else {
        const body = published.body?.trim() || t.publishedNewsFallback;
        await bot.api.sendMessage(
          userId,
          `${t.newsTitle}\n\n${body}`,
          {
            reply_markup: new InlineKeyboard().text(
              t.unsubscribe,
              "marketing:off"
            )
          }
        );
      }
      sent++;
    } catch (error) {
      console.warn("Content notification failed", {
        postId,
        userId,
        error
      });
    }
    await sleep(45);
  }

  await markContentNotified(postId, sent);
  return { ok: true as const, sent, total: userIds.length };
}

async function showLegacyPanel(bot: Bot, userId: number) {
  const stats = await legacyStats();
  const paidChatId = await getPaidChatId();
  let chatCount: number | null = null;
  try {
    if (paidChatId) {
      chatCount = await bot.api.getChatMemberCount(paidChatId);
    }
  } catch (error) {
    console.warn("Could not get paid chat member count", error);
  }

  const text = [
    "👥 Подписки текущих участников — до 12 октября 2026",
    "",
    `Зарегистрировано в боте: ${stats.registered}`,
    `Уже продлили дальше 12 октября: ${stats.renewed}`,
    chatCount === null ? "Участников в чате: не удалось получить" : `Участников в чате сейчас: ${chatCount}`,
    "",
    "Зарегистрированным участникам бот напомнит о продлении за 3 дня. Если подписка не продлена, после окончания бот удалит участника из платного канала и чата.",
    "",
    "Чтобы охватить уже существующих участников, отправьте в платный чат сообщение регистрации или импортируйте Telegram ID списком."
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("📣 Отправить регистрацию в чат", "legacy:notice")
    .row()
    .text("📋 Импортировать Telegram ID", "legacy:import")
    .row()
    .text("🔄 Обновить", "panel:legacy")
    .text("🏠 Админка", "panel:home");

  await bot.api.sendMessage(userId, text, { reply_markup: kb });
}

async function sendLegacyRegistrationNotice(bot: Bot) {
  const paidChatId = await getPaidChatId();
  if (!paidChatId) throw new Error("Paid chat is not bound");

  const me = await bot.api.getMe();
  const url = `https://t.me/${me.username}?start=legacy2026`;
  const kb = new InlineKeyboard().url("✅ Зарегистрировать / Тіркеу", url);

  await bot.api.sendMessage(
    paidChatId,
    [
      "⚠️ Важно: текущая подписка заканчивается 12 октября 2026 года.",
      "Нажмите кнопку ниже, чтобы привязать Telegram-аккаунт и получать напоминания о продлении.",
      "Без продления после окончания срока доступ в платный чат и канал будет закрыт.",
      "",
      "⚠️ Маңызды: ағымдағы жазылым 2026 жылғы 12 қазанда аяқталады.",
      "Telegram аккаунтын тіркеп, жазылымды ұзарту туралы еске салу алу үшін төмендегі батырманы басыңыз.",
      "Ұзартылмаса, мерзімі аяқталғаннан кейін ақылы чат пен арнаға қолжетімділік жабылады."
    ].join("\n"),
    { reply_markup: kb }
  );
  await setSetting("legacy_registration_notice_sent_at", new Date().toISOString());
}

async function showPaidTargets(bot: Bot, userId: number) {
  const [paidChatId, paidChannelId] = await Promise.all([
    getPaidChatId(),
    getPaidChannelId()
  ]);

  await bot.api.sendMessage(
    userId,
    [
      "⚙️ Привязка платного чата и канала",
      "",
      `Платный чат: ${paidChatId || "не привязан"}`,
      `Платный канал: ${paidChannelId || "не привязан"}`,
      "",
      "Для чата: добавьте бота администратором в нужную группу и отправьте там команду /bind_chat.",
      "Для канала: добавьте бота администратором канала и опубликуйте в канале команду /bind_channel.",
      "",
      "После привязки бот сможет выдавать ссылки, проверять заявки и автоматически удалять участников с истёкшей подпиской."
    ].join("\n"),
    { reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home") }
  );
}

export function registerAdminPanel(bot: Bot) {
  bot.command("start", async (ctx, next) => {
    const from = ctx.from;
    if (!from) {
      await next();
      return;
    }
    const payload = String(ctx.match ?? "").trim();
    if (payload !== "legacy2026") {
      await next();
      return;
    }

    const until = await registerLegacyMember(from.id);
    const language = (await getUserLanguage(from.id)) ?? "ru";
    await ctx.reply(TEXTS[language].legacyRegistered(dateForLocale(until, language)));
  });

  bot.command("admin", async ctx => {
    const from = ctx.from;
    if (!from || !isAdmin(from.id)) return;
    adminStates.delete(from.id);
    await showAdminHome(bot, from.id);
  });

  bot.callbackQuery("panel:home", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    adminStates.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    await showAdminHome(bot, ctx.from.id);
  });

  bot.callbackQuery(/^panel:stats:(1|7|30)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const days = Number(ctx.match[1]) as 1 | 7 | 30;
    const s = await adminStatsForDays(days);
    const kb = new InlineKeyboard()
      .text("Сегодня", "panel:stats:1")
      .text("7 дней", "panel:stats:7")
      .text("30 дней", "panel:stats:30")
      .row()
      .text("🏠 Админка", "panel:home");
    await ctx.answerCallbackQuery();
    await ctx.reply(formatAdminReport(s, adminPeriodLabel(days)), {
      parse_mode: "HTML",
      reply_markup: kb
    });
  });

  bot.callbackQuery("panel:price", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const price = await getPrice();
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Текущая цена: ${price.toLocaleString("ru-RU")} ₸.\n\nИзменить: /price 5000`,
      { reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home") }
    );
  });

  bot.callbackQuery("panel:targets", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showPaidTargets(bot, ctx.from.id);
  });

  bot.command("bind_chat", async ctx => {
    const from = ctx.from;
    if (!from || !isAdmin(from.id)) return;
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      await ctx.reply("Команду /bind_chat нужно отправить именно внутри платного чата.");
      return;
    }

    await setPaidChatId(ctx.chat.id);
    await setSetting("legacy_registration_notice_sent_at", "");
    await setSetting("legacy_group_3day_reminder_sent_at", "");
    await ctx.reply("✅ Этот чат привязан как платный Bakieva Chat.");

    try {
      await sendLegacyRegistrationNotice(bot);
      await ctx.reply("✅ Сообщение о подписке до 12 октября опубликовано в этом чате.");
    } catch (error) {
      console.error("Could not send legacy notice after chat binding", error);
    }
  });

  bot.on("channel_post:text", async (ctx, next) => {
    const text = ctx.channelPost.text?.trim() ?? "";
    if (!/^\/bind_channel(?:@\w+)?$/i.test(text)) {
      await next();
      return;
    }

    await setPaidChannelId(ctx.chat.id);
    for (const adminId of config.adminIds) {
      try {
        await bot.api.sendMessage(
          adminId,
          `✅ Канал «${ctx.chat.title ?? "Bakieva Chat"}» привязан как платный канал. ID: ${ctx.chat.id}`
        );
      } catch {
        // Admin may not have started the bot.
      }
    }
  });

  bot.callbackQuery("panel:new:video", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    adminStates.set(ctx.from.id, { mode: "video" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "🎬 Пришлите видео одним сообщением. Если нужен текст под видео — добавьте его в подпись к видео.",
      { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("panel:new:news", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    adminStates.set(ctx.from.id, { mode: "news" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "📰 Отправьте текст новости одним сообщением. После этого бот покажет предпросмотр и предложит выбрать аудиторию.",
      { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("panel:cancel", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    adminStates.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Отменено" });
    await showAdminHome(bot, ctx.from.id);
  });

  bot.callbackQuery("panel:content:list", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showContentList(bot, ctx.from.id);
  });

  bot.callbackQuery(/^content:open:(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCallbackQuery();
    await showDraft(bot, ctx.from.id, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^content:pub:(all|active):(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }

    const audience = ctx.match[1] as "all" | "active";
    const id = Number(ctx.match[2]);
    await ctx.answerCallbackQuery({ text: "Публикую…" });
    const result = await deliverContent(bot, id, audience);
    if (!result.ok) {
      await ctx.reply("Материал уже опубликован, удалён или не найден.");
      return;
    }
    await ctx.reply(
      `✅ Опубликовано. Уведомление доставлено: ${result.sent}/${result.total}.`,
      { reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home") }
    );
  });

  bot.callbackQuery(/^content:del:(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const id = Number(ctx.match[1]);
    const deleted = await deleteContentPost(id);
    await ctx.answerCallbackQuery({
      text: deleted ? "Материал удалён" : "Материал уже удалён"
    });
    await showContentList(bot, ctx.from.id);
  });

  bot.callbackQuery("panel:legacy", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showLegacyPanel(bot, ctx.from.id);
  });

  bot.callbackQuery("legacy:notice", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCallbackQuery({ text: "Отправляю в платный чат…" });
    try {
      await sendLegacyRegistrationNotice(bot);
      await ctx.reply("✅ Сообщение регистрации отправлено в платный чат.");
    } catch (error) {
      console.error("Legacy registration notice failed", error);
      await ctx.reply(
        "❌ Не удалось отправить сообщение в платный чат. Проверьте ID чата и права бота."
      );
    }
  });

  bot.callbackQuery("legacy:import", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    adminStates.set(ctx.from.id, { mode: "legacy_import" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "📋 Пришлите Telegram ID участников одним сообщением — через пробел, запятую или каждый ID с новой строки.\n\nДля всех импортированных участников срок будет установлен до конца 12 октября 2026 года, если их текущая подписка не действует дольше.",
      { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
    );
  });

  bot.on("message:video", async (ctx, next) => {
    if (!isAdmin(ctx.from?.id) || adminStates.get(ctx.from.id)?.mode !== "video") {
      await next();
      return;
    }

    adminStates.delete(ctx.from.id);
    const video = ctx.message.video;
    const caption = ctx.message.caption?.trim() ?? "";
    const draft = await createContentDraft({
      kind: "video",
      title: caption.split("\n")[0]?.slice(0, 120) || "Новое видео",
      body: caption,
      telegramFileId: video.file_id,
      telegramFileUniqueId: video.file_unique_id,
      createdBy: ctx.from.id
    });

    await ctx.reply(`✅ Видео загружено как черновик #${draft.id}.`);
    await showDraft(bot, ctx.from.id, draft.id);
  });

  bot.on("message:text", async (ctx, next) => {
    if (!isAdmin(ctx.from?.id)) {
      await next();
      return;
    }

    const state = adminStates.get(ctx.from.id);
    if (!state) {
      await next();
      return;
    }

    if (state.mode === "news") {
      adminStates.delete(ctx.from.id);
      const body = ctx.message.text.trim();
      if (!body || body.startsWith("/")) {
        await ctx.reply("Отправьте обычный текст новости.");
        return;
      }

      const draft = await createContentDraft({
        kind: "news",
        title: body.split("\n")[0]?.slice(0, 120) || "Новость",
        body,
        createdBy: ctx.from.id
      });
      await ctx.reply(`✅ Новость сохранена как черновик #${draft.id}.`);
      await showDraft(bot, ctx.from.id, draft.id);
      return;
    }

    if (state.mode === "legacy_import") {
      adminStates.delete(ctx.from.id);
      const ids = (ctx.message.text.match(/\d{5,20}/g) ?? [])
        .map(value => Number(value))
        .filter(value => Number.isSafeInteger(value) && value > 0);

      if (ids.length === 0) {
        await ctx.reply("Не нашёл Telegram ID. Откройте импорт ещё раз и пришлите числовые ID.");
        return;
      }

      const result = await registerLegacyMembers(ids);
      await ctx.reply(
        `✅ Импорт завершён: ${result.registered} из ${result.requested} уникальных ID зарегистрированы до 12 октября 2026 года.`,
        { reply_markup: new InlineKeyboard().text("👥 Проверить статус", "panel:legacy") }
      );
      return;
    }

    await next();
  });

  bot.on("message", async (ctx, next) => {
    const paidChatId = await getPaidChatId();
    if (
      paidChatId &&
      ctx.from &&
      !ctx.from.is_bot &&
      !isAdmin(ctx.from.id) &&
      ctx.chat.id === paidChatId &&
      Date.now() < LEGACY_EXPIRES_AT.getTime()
    ) {
      try {
        await registerLegacyMembers([ctx.from.id]);
      } catch (error) {
        console.warn("Could not auto-register legacy member from chat message", {
          userId: ctx.from.id,
          error
        });
      }
    }
    await next();
  });

  bot.on("chat_member", async (ctx, next) => {
    const paidChatId = await getPaidChatId();
    if (
      paidChatId &&
      ctx.chatMember.chat.id === paidChatId &&
      Date.now() < LEGACY_EXPIRES_AT.getTime()
    ) {
      const member = ctx.chatMember.new_chat_member;
      const user = member.user;
      const active =
        member.status === "member" ||
        member.status === "administrator" ||
        member.status === "creator" ||
        (member.status === "restricted" && member.is_member);

      if (active && !user.is_bot && !isAdmin(user.id)) {
        try {
          await registerLegacyMembers([user.id]);
        } catch (error) {
          console.warn("Could not auto-register legacy member from chat update", {
            userId: user.id,
            error
          });
        }
      }
    }
    await next();
  });

  bot.command("legacy_members", async ctx => {
    if (!isAdmin(ctx.from?.id)) return;
    const members = await getLegacyMembers();
    const stats = await legacyStats();
    await ctx.reply(
      [
        `Зарегистрировано: ${stats.registered}`,
        `Продлили дальше 12 октября: ${stats.renewed}`,
        members.length ? `ID: ${members.join(", ")}` : "ID пока нет."
      ].join("\n")
    );
  });
}
