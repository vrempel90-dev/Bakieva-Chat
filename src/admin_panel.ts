import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminStatsForDays,
  clearTrialVideoAsset,
  createContentDraft,
  deleteContentPost,
  getActiveNotificationUsers,
  getContentPost,
  currentChatMemberStats,
  forgetCurrentChatMember,
  getLegacyMembers,
  getMarketingUsers,
  getPrice,
  getPaidChannelId,
  getPaidChatId,
  getSetting,
  getUserLanguage,
  legacyStats,
  listContentPosts,
  markContentNotified,
  publishContentPost,
  rememberCurrentChatMember,
  registerLegacyMember,
  registerLegacyMembers,
  setPaidChannelId,
  setPaidChatId,
  setSetting,
  setTrialVideoTelegramFileId,
  LEGACY_EXPIRES_AT
} from "./db.js";
import { formatAdminReport } from "./admin_reports.js";
import { c, localeFor } from "./i18n.js";
import {
  createInstagramAutomation,
  deleteInstagramAutomation,
  getInstagramAutomation,
  instagramAutomationStats,
  listInstagramAutomations,
  toggleInstagramAutomation,
  type InstagramAutomationMatchMode,
  type InstagramAutomationScope
} from "./instagram_db.js";
import { normalizeKeywordList } from "./instagram_rules.js";
import { instagramConfigurationStatus } from "./instagram_service.js";
import {
  instagramReelsConfigurationStatus,
  instagramReelsReadyForPublishing,
  publishInstagramReel
} from "./instagram_reels.js";
import {
  createInstagramReelPublication,
  listInstagramReelPublications,
  markInstagramReelContainer,
  markInstagramReelFailed,
  markInstagramReelPublished
} from "./instagram_reels_db.js";

type AdminState =
  | { mode: "video" }
  | { mode: "news" }
  | { mode: "legacy_import" }
  | { mode: "trial_video_ru_part1" }
  | { mode: "trial_video_ru_part2" }
  | { mode: "trial_video_kk_part1" }
  | { mode: "trial_video_kk_part2" }
  | { mode: "instagram_media_id" }
  | { mode: "instagram_keywords" }
  | { mode: "instagram_dm" }
  | { mode: "instagram_reel_video" }
  | { mode: "instagram_reel_caption" }
  | { mode: "instagram_reel_keywords" }
  | { mode: "instagram_reel_dm" };

type InstagramDraft = {
  scope?: InstagramAutomationScope;
  mediaId?: string | null;
  matchMode?: InstagramAutomationMatchMode;
  keywords: string[];
};

type InstagramReelDraft = {
  telegramFileId?: string;
  telegramFileUniqueId?: string;
  telegramKind?: "video" | "document";
  mimeType?: string;
  caption: string;
  matchMode?: InstagramAutomationMatchMode;
  keywords: string[];
  dmText?: string;
  publishing?: boolean;
};

const adminStates = new Map<number, AdminState>();
const trialVideoDrafts = new Map<number, { ruPart1?: string; kkPart1?: string }>();
const instagramDrafts = new Map<number, InstagramDraft>();
const instagramReelDrafts = new Map<number, InstagramReelDraft>();

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
    .text("🇷🇺 Пробное видео RU", "panel:trial:ru")
    .text("🇰🇿 Пробное видео KZ", "panel:trial:kk")
    .row()
    .text("📚 Материалы", "panel:content:list")
    .row()
    .text("👥 Участники сообщества", "panel:legacy")
    .row()
    .text("📸 Instagram автоответчик", "panel:instagram")
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

function instagramTriggerKeyboard() {
  return new InlineKeyboard()
    .text("💬 Любой комментарий", "instagram:mode:all")
    .row()
    .text("🔑 По ключевым словам", "instagram:mode:keywords")
    .row()
    .text("❌ Отмена", "panel:cancel");
}

function instagramReelTriggerKeyboard() {
  return new InlineKeyboard()
    .text("💬 Любой комментарий", "instagram:reel:mode:all")
    .row()
    .text("🔑 По ключевым словам", "instagram:reel:mode:keywords")
    .row()
    .text("❌ Отмена", "panel:cancel");
}

async function askInstagramReelTrigger(bot: Bot, userId: number) {
  await bot.api.sendMessage(
    userId,
    "На какие комментарии под этим Reels должен реагировать автоответчик?",
    { reply_markup: instagramReelTriggerKeyboard() }
  );
}

async function showInstagramReelPreview(bot: Bot, userId: number, draft: InstagramReelDraft) {
  if (!draft.telegramFileId || !draft.matchMode || !draft.dmText) {
    await bot.api.sendMessage(userId, "Черновик Reels неполный. Начните публикацию заново.");
    return;
  }

  const previewCaption = draft.caption
    ? draft.caption.slice(0, 1000)
    : "Предпросмотр Reels без подписи";

  if (draft.telegramKind === "document") {
    await bot.api.sendDocument(userId, draft.telegramFileId, { caption: previewCaption });
  } else {
    await bot.api.sendVideo(userId, draft.telegramFileId, {
      caption: previewCaption,
      supports_streaming: true
    });
  }

  const trigger = draft.matchMode === "all"
    ? "любой комментарий"
    : `ключевые слова: ${draft.keywords.join(", ")}`;

  await bot.api.sendMessage(
    userId,
    [
      "🎬 Reels готов к публикации",
      "",
      `Триггер: ${trigger}`,
      "",
      "Сообщение в Direct:",
      draft.dmText,
      "",
      "После публикации бот сам получит Instagram Media ID и включит правило для этого Reels."
    ].join("\n"),
    {
      reply_markup: new InlineKeyboard()
        .text("🚀 Опубликовать Reels", "instagram:reel:publish")
        .row()
        .text("❌ Отмена", "panel:cancel")
    }
  );
}

async function showInstagramPanel(bot: Bot, userId: number) {
  const [stats, rules, reels] = await Promise.all([
    instagramAutomationStats(),
    listInstagramAutomations(10),
    listInstagramReelPublications(5)
  ]);
  const cfg = instagramConfigurationStatus();
  const reelsCfg = instagramReelsConfigurationStatus();
  const configured =
    cfg.appId &&
    cfg.appSecret &&
    cfg.verifyToken &&
    cfg.accessToken &&
    cfg.igUserId &&
    cfg.graphVersion;

  const missing = [
    !cfg.appId ? "META_APP_ID" : "",
    !cfg.appSecret ? "META_APP_SECRET" : "",
    !cfg.verifyToken ? "META_WEBHOOK_VERIFY_TOKEN" : "",
    !cfg.accessToken ? "INSTAGRAM_ACCESS_TOKEN" : "",
    !cfg.igUserId ? "INSTAGRAM_IG_USER_ID" : "",
    !cfg.graphVersion ? "META_GRAPH_VERSION" : ""
  ].filter(Boolean);

  const lines = [
    "📸 Instagram автоответчик",
    "",
    configured
      ? "🟢 Meta API подключён"
      : "🟡 Техническая часть готова, Meta API пока не подключён",
    missing.length ? `Не хватает: ${missing.join(", ")}` : "",
    "",
    `Правил: ${stats.totalRules}`,
    `Включено: ${stats.enabledRules}`,
    `Direct отправлено: ${stats.sent}`,
    `Ошибок отправки: ${stats.failed}`,
    "",
    instagramReelsReadyForPublishing()
      ? "🎬 Публикация Reels: 🟢 готова"
      : "🎬 Публикация Reels: 🟡 не настроена полностью",
    !reelsCfg.publicBaseUrl ? "Для Reels не найден PUBLIC_BASE_URL/RAILWAY_PUBLIC_DOMAIN" : "",
    reels.length
      ? "Последние Reels:\n" + reels.map(item => {
          const icon = item.status === "published" ? "✅" : item.status === "failed" ? "❌" : "⏳";
          return `${icon} #${item.id}${item.mediaId ? ` · Media ${item.mediaId}` : ""}`;
        }).join("\n")
      : "",
    "",
    "Webhook: /webhooks/instagram"
  ].filter(Boolean);

  const kb = new InlineKeyboard()
    .text("🎬 Новый Reels", "instagram:reel:new")
    .row()
    .text("➕ Создать автоответ", "instagram:new")
    .row();

  for (const rule of rules) {
    kb.text(
      `${rule.enabled ? "✅" : "⏸"} #${rule.id} ${rule.name.slice(0, 28)}`,
      `instagram:open:${rule.id}`
    ).row();
  }

  kb.text("🔄 Обновить", "panel:instagram")
    .row()
    .text("🏠 Админка", "panel:home");

  await bot.api.sendMessage(userId, lines.join("\n"), { reply_markup: kb });
}

async function showInstagramRule(bot: Bot, userId: number, id: number) {
  const rule = await getInstagramAutomation(id);
  if (!rule) {
    await bot.api.sendMessage(userId, "Правило не найдено.", {
      reply_markup: new InlineKeyboard().text("⬅️ Instagram", "panel:instagram")
    });
    return;
  }

  const scope = rule.scope === "all_media"
    ? "Все новые публикации"
    : `Media ID: ${rule.mediaId}`;
  const trigger = rule.matchMode === "all"
    ? "Любой комментарий"
    : `Ключевые слова: ${rule.keywords.join(", ")}`;

  await bot.api.sendMessage(
    userId,
    [
      `📸 Правило #${rule.id}`,
      "",
      `Статус: ${rule.enabled ? "✅ включено" : "⏸ выключено"}`,
      `Охват: ${scope}`,
      `Триггер: ${trigger}`,
      "",
      "Сообщение в Direct:",
      rule.dmText
    ].join("\n"),
    {
      reply_markup: new InlineKeyboard()
        .text(rule.enabled ? "⏸ Выключить" : "▶️ Включить", `instagram:toggle:${rule.id}`)
        .row()
        .text("🗑 Удалить", `instagram:delete:${rule.id}`)
        .row()
        .text("⬅️ Instagram", "panel:instagram")
    }
  );
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
      const lang = await getUserLanguage(userId);
      const ui = c(lang);
      if (published.kind === "video" && published.telegramFileId) {
        const caption = [
          ui.newVideo,
          published.body?.trim() ?? ""
        ].filter(Boolean).join("\n\n").slice(0, 1000);
        await bot.api.sendVideo(userId, published.telegramFileId, {
          caption,
          reply_markup: new InlineKeyboard().text(
            ui.notificationsOffButton,
            "marketing:off"
          )
        });
      } else {
        const body = published.body?.trim() || ui.newNewsFallback;
        await bot.api.sendMessage(
          userId,
          `${ui.newNews}\n\n${body}`,
          {
            reply_markup: new InlineKeyboard().text(
              ui.notificationsOffButton,
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
  const paidChatId = await getPaidChatId();
  let chatCount: number | null = null;
  let trackedActive = 0;
  let trackedSeen = 0;

  try {
    if (paidChatId) {
      chatCount = await bot.api.getChatMemberCount(paidChatId);
      const tracked = await currentChatMemberStats(paidChatId);
      trackedActive = tracked.active;
      trackedSeen = tracked.seen;
    }
  } catch (error) {
    console.warn("Could not get paid chat member state", error);
  }

  const text = [
    "👥 Текущие участники Bakieva Chat",
    "",
    chatCount === null ? "Участников в чате: не удалось получить" : `Участников в чате сейчас: ${chatCount}`,
    `Бот уже запомнил активных участников: ${trackedActive}`,
    `Всего замечено ботом: ${trackedSeen}`,
    "",
    "С этого момента бот запоминает участников по сообщениям и изменениям состава чата.",
    "22 октября 2026 года бот опубликует в этом чате напоминание о продлении и дополнительно отправит личное сообщение тем участникам, которым Telegram разрешает писать напрямую."
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("🔄 Обновить", "panel:legacy")
    .text("🏠 Админка", "panel:home");

  await bot.api.sendMessage(userId, text, { reply_markup: kb });
}

async function sendLegacyRegistrationNotice(bot: Bot) {
  const paidChatId = await getPaidChatId();
  if (!paidChatId) throw new Error("Paid chat is not bound");

  const me = await bot.api.getMe();
  const url = `https://t.me/${me.username}?start=legacy2026`;
  const kb = new InlineKeyboard().url("✅ Регистрация / Тіркелу", url);

  await bot.api.sendMessage(
    paidChatId,
    [
      "⚠️ Важно: текущая подписка заканчивается 12 октября 2026 года.",
      "Нажмите кнопку ниже, чтобы бот привязал ваш Telegram-аккаунт к действующей подписке и заранее напомнил о продлении.",
      "Если подписка не будет продлена, доступ в платный чат и канал будет закрыт.",
      "",
      "⚠️ Маңызды: ағымдағы жазылым 2026 жылғы 12 қазанда аяқталады.",
      "Төмендегі батырманы басып, Telegram аккаунтыңызды тіркеңіз. Бот жазылымды ұзарту туралы алдын ала еске салады.",
      "Жазылым ұзартылмаса, ақылы чат пен арнаға қолжетімділік жабылады."
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
    const lang = await getUserLanguage(from.id);
    const ui = c(lang);
    await ctx.reply(
      ui.legacyRegistered(until.toLocaleDateString(localeFor(lang)))
    );
  });

  bot.command("admin", async ctx => {
    const from = ctx.from;
    if (!from || !isAdmin(from.id)) return;
    adminStates.delete(from.id);
    trialVideoDrafts.delete(from.id);
    instagramDrafts.delete(from.id);
    instagramReelDrafts.delete(from.id);
    await showAdminHome(bot, from.id);
  });

  bot.callbackQuery("panel:home", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    adminStates.delete(ctx.from.id);
    trialVideoDrafts.delete(ctx.from.id);
    instagramDrafts.delete(ctx.from.id);
    instagramReelDrafts.delete(ctx.from.id);
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

  bot.callbackQuery("panel:instagram", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    adminStates.delete(ctx.from.id);
    trialVideoDrafts.delete(ctx.from.id);
    instagramDrafts.delete(ctx.from.id);
    instagramReelDrafts.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    await showInstagramPanel(bot, ctx.from.id);
  });


  bot.callbackQuery("instagram:reel:new", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }

    const status = instagramReelsConfigurationStatus();
    const autoReplyStatus = instagramConfigurationStatus();
    const reelFlowReady =
      instagramReelsReadyForPublishing() &&
      autoReplyStatus.appId &&
      autoReplyStatus.appSecret &&
      autoReplyStatus.verifyToken;

    if (!reelFlowReady) {
      const missing = [
        !status.accessToken ? "INSTAGRAM_ACCESS_TOKEN" : "",
        !status.igUserId ? "INSTAGRAM_IG_USER_ID" : "",
        !status.graphVersion ? "META_GRAPH_VERSION" : "",
        !status.publicBaseUrl ? "PUBLIC_BASE_URL/RAILWAY_PUBLIC_DOMAIN" : "",
        !autoReplyStatus.appId ? "META_APP_ID" : "",
        !autoReplyStatus.appSecret ? "META_APP_SECRET" : "",
        !autoReplyStatus.verifyToken ? "META_WEBHOOK_VERIFY_TOKEN" : ""
      ].filter(Boolean);
      await ctx.answerCallbackQuery({
        text: "Публикация Reels пока не настроена",
        show_alert: true
      });
      await ctx.reply(`Не хватает для публикации Reels: ${missing.join(", ")}`);
      return;
    }

    instagramDrafts.delete(ctx.from.id);
    instagramReelDrafts.set(ctx.from.id, { caption: "", keywords: [] });
    adminStates.set(ctx.from.id, { mode: "instagram_reel_video" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "🎬 Пришлите Reels-видео. Можно сразу добавить подпись к публикации в caption сообщения.",
      { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("instagram:reel:mode:all", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const draft = instagramReelDrafts.get(ctx.from.id);
    if (!draft?.telegramFileId) {
      await ctx.answerCallbackQuery({ text: "Черновик устарел. Начните заново.", show_alert: true });
      return;
    }
    draft.matchMode = "all";
    draft.keywords = [];
    instagramReelDrafts.set(ctx.from.id, draft);
    adminStates.set(ctx.from.id, { mode: "instagram_reel_dm" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Введите сообщение, которое человек получит в Instagram Direct после комментария.",
      { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("instagram:reel:mode:keywords", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const draft = instagramReelDrafts.get(ctx.from.id);
    if (!draft?.telegramFileId) {
      await ctx.answerCallbackQuery({ text: "Черновик устарел. Начните заново.", show_alert: true });
      return;
    }
    draft.matchMode = "keywords";
    instagramReelDrafts.set(ctx.from.id, draft);
    adminStates.set(ctx.from.id, { mode: "instagram_reel_keywords" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Введите ключевые слова через запятую или с новой строки. Например:\nрецепт, хочу рецепт, гайд",
      { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("instagram:reel:publish", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const draft = instagramReelDrafts.get(ctx.from.id);
    if (!draft?.telegramFileId || !draft.matchMode || !draft.dmText) {
      await ctx.answerCallbackQuery({ text: "Черновик неполный. Начните заново.", show_alert: true });
      return;
    }
    if (draft.publishing) {
      await ctx.answerCallbackQuery({ text: "Этот Reels уже публикуется.", show_alert: true });
      return;
    }
    draft.publishing = true;
    instagramReelDrafts.set(ctx.from.id, draft);

    await ctx.answerCallbackQuery({ text: "Публикую Reels…" });
    const statusMessage = await ctx.reply("⏳ Создаю Reels в Instagram…");
    let publicationId: number | null = null;
    let publishedMediaId: string | null = null;

    const updateStatus = async (text: string) => {
      try {
        await bot.api.editMessageText(ctx.from.id, statusMessage.message_id, text);
      } catch {
        // Status message may already contain the same text.
      }
    };

    try {
      const job = await createInstagramReelPublication({
        telegramFileId: draft.telegramFileId,
        telegramFileUniqueId: draft.telegramFileUniqueId,
        mimeType: draft.mimeType,
        caption: draft.caption,
        createdBy: ctx.from.id
      });
      publicationId = job.id;

      const published = await publishInstagramReel({
        telegramFileId: draft.telegramFileId,
        mimeType: draft.mimeType,
        caption: draft.caption,
        onProgress: async progress => {
          if (progress.stage === "container_created") {
            await markInstagramReelContainer(job.id, progress.containerId);
            await updateStatus("⏳ Видео принято Instagram. Идёт обработка Reels…");
          } else if (progress.stage === "ready") {
            await updateStatus("⏳ Видео обработано. Публикую Reels…");
          }
        }
      });
      publishedMediaId = published.mediaId;

      let automationId: number | null = null;
      let automationWarning: string | null = null;

      try {
        const rule = await createInstagramAutomation({
          name: `Reels ${published.mediaId}`,
          scope: "media",
          mediaId: published.mediaId,
          matchMode: draft.matchMode,
          keywords: draft.keywords,
          dmText: draft.dmText,
          createdBy: ctx.from.id,
          enabled: true
        });
        automationId = rule.id;
      } catch (error) {
        automationWarning = error instanceof Error ? error.message : String(error);
        console.error("Reels published but Instagram automation creation failed", {
          mediaId: published.mediaId,
          error
        });
      }

      await markInstagramReelPublished({
        id: job.id,
        mediaId: published.mediaId,
        automationId,
        warning: automationWarning
      });

      adminStates.delete(ctx.from.id);
      instagramReelDrafts.delete(ctx.from.id);

      if (automationId) {
        await updateStatus(
          `✅ Reels опубликован. Media ID: ${published.mediaId}\n✅ Автоответ #${automationId} включён.`
        );
        await showInstagramRule(bot, ctx.from.id, automationId);
      } else {
        await updateStatus(
          `⚠️ Reels опубликован. Media ID: ${published.mediaId}\nАвтоответ не удалось создать автоматически. Media ID сохранён в истории Reels.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      draft.publishing = false;
      instagramReelDrafts.set(ctx.from.id, draft);
      console.error("Instagram Reels publishing failed", error);

      if (publishedMediaId) {
        await updateStatus(
          `⚠️ Reels уже опубликован. Media ID: ${publishedMediaId}\nНо не удалось завершить внутреннюю настройку:\n${message.slice(0, 800)}`
        );
        return;
      }

      if (publicationId) await markInstagramReelFailed(publicationId, message);
      await updateStatus(`❌ Не удалось опубликовать Reels.\n${message.slice(0, 900)}\n\nМожно нажать «Опубликовать Reels» ещё раз после исправления причины.`);
    }
  });

  bot.callbackQuery("instagram:new", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    adminStates.delete(ctx.from.id);
    instagramDrafts.set(ctx.from.id, { keywords: [] });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Где должен работать автоответ?",
      {
        reply_markup: new InlineKeyboard()
          .text("🌐 На всех новых публикациях", "instagram:scope:all")
          .row()
          .text("🎯 На конкретной публикации", "instagram:scope:media")
          .row()
          .text("❌ Отмена", "panel:cancel")
      }
    );
  });

  bot.callbackQuery("instagram:scope:all", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    instagramDrafts.set(ctx.from.id, {
      scope: "all_media",
      mediaId: null,
      keywords: []
    });
    adminStates.delete(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply("На какие комментарии реагировать?", {
      reply_markup: instagramTriggerKeyboard()
    });
  });

  bot.callbackQuery("instagram:scope:media", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    instagramDrafts.set(ctx.from.id, {
      scope: "media",
      keywords: []
    });
    adminStates.set(ctx.from.id, { mode: "instagram_media_id" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Отправьте числовой Instagram Media ID публикации/Reels.",
      { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("instagram:mode:all", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const draft = instagramDrafts.get(ctx.from.id);
    if (!draft?.scope) {
      await ctx.answerCallbackQuery({ text: "Создание правила устарело. Начните заново.", show_alert: true });
      return;
    }
    draft.matchMode = "all";
    draft.keywords = [];
    instagramDrafts.set(ctx.from.id, draft);
    adminStates.set(ctx.from.id, { mode: "instagram_dm" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Введите сообщение, которое человек получит в Instagram Direct после комментария.",
      { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("instagram:mode:keywords", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const draft = instagramDrafts.get(ctx.from.id);
    if (!draft?.scope) {
      await ctx.answerCallbackQuery({ text: "Создание правила устарело. Начните заново.", show_alert: true });
      return;
    }
    draft.matchMode = "keywords";
    instagramDrafts.set(ctx.from.id, draft);
    adminStates.set(ctx.from.id, { mode: "instagram_keywords" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "Введите ключевые слова через запятую или с новой строки. Например:\nрецепт, хочу рецепт, гайд",
      { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery(/^instagram:open:(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCallbackQuery();
    await showInstagramRule(bot, ctx.from.id, Number(ctx.match[1]));
  });

  bot.callbackQuery(/^instagram:toggle:(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const rule = await toggleInstagramAutomation(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({
      text: rule ? (rule.enabled ? "Правило включено" : "Правило выключено") : "Правило не найдено"
    });
    if (rule) await showInstagramRule(bot, ctx.from.id, rule.id);
  });

  bot.callbackQuery(/^instagram:delete:(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    const deleted = await deleteInstagramAutomation(Number(ctx.match[1]));
    await ctx.answerCallbackQuery({
      text: deleted ? "Правило удалено" : "Правило уже удалено"
    });
    await showInstagramPanel(bot, ctx.from.id);
  });

  bot.callbackQuery("panel:targets", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showPaidTargets(bot, ctx.from.id);
  });

  bot.on("my_chat_member", async (ctx, next) => {
    const chat = ctx.myChatMember.chat;
    if (chat.type !== "group" && chat.type !== "supergroup") {
      await next();
      return;
    }

    const status = ctx.myChatMember.new_chat_member.status;
    const isAdminNow = status === "administrator" || status === "creator";
    if (!isAdminNow) {
      await next();
      return;
    }

    const previousChatId = await getPaidChatId();
    if (!previousChatId) {
      await setPaidChatId(chat.id);
      await setSetting("community_renewal_2026_10_22_sent_at", "");
      await setSetting("community_renewal_2026_10_22_dm_sent_at", "");
      await setSetting("community_renewal_2026_10_22_dm_stats", "");

      for (const adminId of config.adminIds) {
        try {
          await bot.api.sendMessage(
            adminId,
            `✅ Бот добавлен администратором в «${chat.title ?? "Bakieva Chat"}» и привязал его как платный чат, потому что платный чат ещё не был настроен.`
          );
        } catch {
          // Admin may not have started the bot.
        }
      }
    } else if (previousChatId !== chat.id) {
      for (const adminId of config.adminIds) {
        try {
          await bot.api.sendMessage(
            adminId,
            `ℹ️ Бот добавлен администратором в новый чат «${chat.title ?? "без названия"}». Платный чат НЕ изменён. Если это «Болталка» для AI-повара — отправьте в ней /bind_chef. Для намеренной смены платного чата используйте /bind_chat.`
          );
        } catch {
          // Admin may not have started the bot.
        }
      }
    }

    await next();
  });

  bot.command("bind_chat", async ctx => {
    const from = ctx.from;
    if (!from || !isAdmin(from.id)) return;
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      await ctx.reply("Команду /bind_chat нужно отправить именно внутри платного чата.");
      return;
    }

    await setPaidChatId(ctx.chat.id);
    await setSetting("community_renewal_2026_10_22_sent_at", "");
    await ctx.reply(
      "✅ Этот чат привязан как платный Bakieva Chat. Бот начал запоминать участников. Напоминание о продлении запланировано на 22 октября 2026 года."
    );
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

  bot.callbackQuery(/^panel:trial:(ru|kk)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const lang = ctx.match[1] as "ru" | "kk";
    trialVideoDrafts.delete(ctx.from.id);
    adminStates.set(ctx.from.id, {
      mode: lang === "ru" ? "trial_video_ru_part1" : "trial_video_kk_part1"
    });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      lang === "ru"
        ? "🇷🇺 Пришлите ЧАСТЬ 1 нового русского пробного урока. После неё бот попросит часть 2. Старое видео будет удалено только после успешной загрузки обеих частей."
        : "🇰🇿 Жаңа қазақша сынақ сабағының 1-БӨЛІМІН жіберіңіз. Одан кейін бот 2-бөлімді сұрайды. Ескі видео екі бөлік те сәтті жүктелгеннен кейін ғана өшіріледі.",
      { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
    );
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
    trialVideoDrafts.delete(ctx.from.id);
    instagramDrafts.delete(ctx.from.id);
    instagramReelDrafts.delete(ctx.from.id);
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
    if (!isAdmin(ctx.from?.id)) {
      await next();
      return;
    }

    const state = adminStates.get(ctx.from.id);
    if (!state || !["video", "trial_video_ru_part1", "trial_video_ru_part2", "trial_video_kk_part1", "trial_video_kk_part2", "instagram_reel_video"].includes(state.mode)) {
      await next();
      return;
    }

    const video = ctx.message.video;
    if (
      state.mode === "instagram_reel_video" &&
      typeof video.file_size === "number" &&
      video.file_size > 20 * 1024 * 1024
    ) {
      await ctx.reply(
        "Этот файл больше 20 МБ. Через обычный Telegram Bot API бот не сможет скачать его для передачи в Instagram. Пришлите сжатую версию до 20 МБ."
      );
      return;
    }

    adminStates.delete(ctx.from.id);

    if (state.mode === "instagram_reel_video") {
      const caption = ctx.message.caption?.trim() ?? "";
      const draft: InstagramReelDraft = {
        telegramFileId: video.file_id,
        telegramFileUniqueId: video.file_unique_id,
        telegramKind: "video",
        mimeType: video.mime_type || "video/mp4",
        caption: caption.slice(0, 2200),
        keywords: []
      };
      instagramReelDrafts.set(ctx.from.id, draft);

      if (caption.length > 2200) {
        adminStates.set(ctx.from.id, { mode: "instagram_reel_caption" });
        draft.caption = "";
        await ctx.reply(
          "Видео сохранено, но подпись длиннее 2200 символов. Пришлите более короткую подпись или «-» без подписи.",
          { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
        );
        return;
      }

      if (!caption) {
        adminStates.set(ctx.from.id, { mode: "instagram_reel_caption" });
        await ctx.reply(
          "Видео принято. Теперь пришлите подпись к Reels или отправьте «-», если подпись не нужна.",
          { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
        );
        return;
      }

      await askInstagramReelTrigger(bot, ctx.from.id);
      return;
    }

    if (state.mode === "trial_video_ru_part1") {
      trialVideoDrafts.set(ctx.from.id, { ruPart1: video.file_id });
      adminStates.set(ctx.from.id, { mode: "trial_video_ru_part2" });
      await ctx.reply(
        "✅ Часть 1 принята. Теперь пришлите ЧАСТЬ 2 русского пробного урока.",
        { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
      );
      return;
    }

    if (state.mode === "trial_video_ru_part2") {
      const part1 = trialVideoDrafts.get(ctx.from.id)?.ruPart1;
      if (!part1) {
        adminStates.set(ctx.from.id, { mode: "trial_video_ru_part1" });
        await ctx.reply("Черновик первой части потерян. Пришлите часть 1 ещё раз.");
        return;
      }

      const part2 = video.file_id;
      const paidChatId = await getPaidChatId();

      const previousIds = [
        Number(await getSetting("trial_video_message_id_ru", "0")),
        Number(await getSetting("trial_video_message_id_ru_part1", "0")),
        Number(await getSetting("trial_video_message_id_ru_part2", "0"))
      ].filter(id => Number.isSafeInteger(id) && id > 0);

      let sent1: { message_id: number } | null = null;
      let sent2: { message_id: number } | null = null;

      if (paidChatId) {
        sent1 = await bot.api.sendVideo(paidChatId, part1, {
          supports_streaming: true,
          caption: "🎬 Бесплатный пробный урок «Клубничка» — часть 1 из 2"
        });
        sent2 = await bot.api.sendVideo(paidChatId, part2, {
          supports_streaming: true,
          caption: "🎬 Бесплатный пробный урок «Клубничка» — часть 2 из 2"
        });
      }

      await Promise.all([
        setSetting("trial_video_file_id_ru_part1", part1),
        setSetting("trial_video_file_id_ru_part2", part2),
        setSetting("trial_video_file_id_ru", ""),
        clearTrialVideoAsset("ru")
      ]);

      if (sent1) {
        await setSetting("trial_video_message_id_ru_part1", String(sent1.message_id));
      }
      if (sent2) {
        await setSetting("trial_video_message_id_ru_part2", String(sent2.message_id));
      }
      await setSetting("trial_video_message_id_ru", "");

      if (paidChatId) {
        for (const messageId of previousIds) {
          if (messageId === sent1?.message_id || messageId === sent2?.message_id) continue;
          try {
            await bot.api.deleteMessage(paidChatId, messageId);
          } catch (error) {
            console.warn("Could not delete previous RU trial video message", {
              paidChatId,
              messageId,
              error
            });
          }
        }
      }

      trialVideoDrafts.delete(ctx.from.id);
      console.info("Russian trial video replaced with two parts", {
        adminId: ctx.from.id,
        part2FileUniqueId: video.file_unique_id
      });

      await ctx.reply(
        "✅ Русский пробный урок заменён. Старое активное видео удалено, а пользователям теперь сразу показываются две новые части: 1/2 и 2/2.",
        { reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home") }
      );
      return;
    }

    if (state.mode === "trial_video_kk_part1") {
      trialVideoDrafts.set(ctx.from.id, { kkPart1: video.file_id });
      adminStates.set(ctx.from.id, { mode: "trial_video_kk_part2" });
      await ctx.reply(
        "✅ 1-бөлім қабылданды. Енді қазақша сынақ сабағының 2-БӨЛІМІН жіберіңіз.",
        { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
      );
      return;
    }

    if (state.mode === "trial_video_kk_part2") {
      const part1 = trialVideoDrafts.get(ctx.from.id)?.kkPart1;
      if (!part1) {
        adminStates.set(ctx.from.id, { mode: "trial_video_kk_part1" });
        await ctx.reply("1-бөлімнің черновигі жоғалды. 1-бөлімді қайта жіберіңіз.");
        return;
      }

      const part2 = video.file_id;
      const paidChatId = await getPaidChatId();

      const previousIds = [
        Number(await getSetting("trial_video_message_id_kk", "0")),
        Number(await getSetting("trial_video_message_id_kk_part1", "0")),
        Number(await getSetting("trial_video_message_id_kk_part2", "0"))
      ].filter(id => Number.isSafeInteger(id) && id > 0);

      let sent1: { message_id: number } | null = null;
      let sent2: { message_id: number } | null = null;

      if (paidChatId) {
        sent1 = await bot.api.sendVideo(paidChatId, part1, {
          supports_streaming: true,
          caption: "🎬 «Құлпынай» тегін сынақ сабағы — 1-бөлім / 2"
        });
        sent2 = await bot.api.sendVideo(paidChatId, part2, {
          supports_streaming: true,
          caption: "🎬 «Құлпынай» тегін сынақ сабағы — 2-бөлім / 2"
        });
      }

      await Promise.all([
        setSetting("trial_video_file_id_kk_part1", part1),
        setSetting("trial_video_file_id_kk_part2", part2),
        setSetting("trial_video_file_id_kk", ""),
        clearTrialVideoAsset("kk")
      ]);

      if (sent1) {
        await setSetting("trial_video_message_id_kk_part1", String(sent1.message_id));
      }
      if (sent2) {
        await setSetting("trial_video_message_id_kk_part2", String(sent2.message_id));
      }
      await setSetting("trial_video_message_id_kk", "");

      if (paidChatId) {
        for (const messageId of previousIds) {
          if (messageId === sent1?.message_id || messageId === sent2?.message_id) continue;
          try {
            await bot.api.deleteMessage(paidChatId, messageId);
          } catch (error) {
            console.warn("Could not delete previous KK trial video message", {
              paidChatId,
              messageId,
              error
            });
          }
        }
      }

      trialVideoDrafts.delete(ctx.from.id);
      console.info("Kazakh trial video replaced with two parts", {
        adminId: ctx.from.id,
        part2FileUniqueId: video.file_unique_id
      });

      await ctx.reply(
        "✅ Қазақша сынақ сабағы ауыстырылды. Ескі белсенді видео өшірілді, енді пайдаланушыларға бірден екі жаңа бөлік көрсетіледі: 1/2 және 2/2.",
        { reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home") }
      );
      return;
    }

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


  bot.on("message:document", async (ctx, next) => {
    if (!isAdmin(ctx.from?.id)) {
      await next();
      return;
    }

    const state = adminStates.get(ctx.from.id);
    if (state?.mode !== "instagram_reel_video") {
      await next();
      return;
    }

    const document = ctx.message.document;
    const mimeType = document.mime_type ?? "";
    const fileName = document.file_name?.toLowerCase() ?? "";
    const looksLikeVideo =
      mimeType.startsWith("video/") ||
      fileName.endsWith(".mp4") ||
      fileName.endsWith(".mov");

    if (!looksLikeVideo) {
      await ctx.reply("Для Reels нужен видеофайл MP4/MOV.");
      return;
    }

    if (
      typeof document.file_size === "number" &&
      document.file_size > 20 * 1024 * 1024
    ) {
      await ctx.reply(
        "Этот файл больше 20 МБ. Через обычный Telegram Bot API бот не сможет скачать его для передачи в Instagram. Пришлите сжатую версию до 20 МБ."
      );
      return;
    }

    adminStates.delete(ctx.from.id);
    const caption = ctx.message.caption?.trim() ?? "";
    const draft: InstagramReelDraft = {
      telegramFileId: document.file_id,
      telegramFileUniqueId: document.file_unique_id,
      telegramKind: "document",
      mimeType: mimeType || "video/mp4",
      caption: caption.slice(0, 2200),
      keywords: []
    };
    instagramReelDrafts.set(ctx.from.id, draft);

    if (caption.length > 2200) {
      adminStates.set(ctx.from.id, { mode: "instagram_reel_caption" });
      draft.caption = "";
      await ctx.reply(
        "Видео сохранено, но подпись длиннее 2200 символов. Пришлите более короткую подпись или «-» без подписи.",
        { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
      );
      return;
    }

    if (!caption) {
      adminStates.set(ctx.from.id, { mode: "instagram_reel_caption" });
      await ctx.reply(
        "Видео принято. Теперь пришлите подпись к Reels или отправьте «-», если подпись не нужна.",
        { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
      );
      return;
    }

    await askInstagramReelTrigger(bot, ctx.from.id);
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

    if (state.mode === "instagram_reel_caption") {
      const draft = instagramReelDrafts.get(ctx.from.id);
      if (!draft?.telegramFileId) {
        adminStates.delete(ctx.from.id);
        instagramReelDrafts.delete(ctx.from.id);
        await ctx.reply("Черновик Reels устарел. Начните публикацию заново.");
        return;
      }

      const raw = ctx.message.text.trim();
      if (raw.startsWith("/")) {
        await ctx.reply("Пришлите подпись обычным текстом или «-» без подписи.");
        return;
      }
      const caption = raw === "-" ? "" : raw;
      if (caption.length > 2200) {
        await ctx.reply("Подпись слишком длинная. Максимум 2200 символов.");
        return;
      }

      draft.caption = caption;
      instagramReelDrafts.set(ctx.from.id, draft);
      adminStates.delete(ctx.from.id);
      await askInstagramReelTrigger(bot, ctx.from.id);
      return;
    }

    if (state.mode === "instagram_reel_keywords") {
      const draft = instagramReelDrafts.get(ctx.from.id);
      if (!draft?.telegramFileId) {
        adminStates.delete(ctx.from.id);
        instagramReelDrafts.delete(ctx.from.id);
        await ctx.reply("Черновик Reels устарел. Начните публикацию заново.");
        return;
      }

      const keywords = normalizeKeywordList(ctx.message.text);
      if (!keywords.length) {
        await ctx.reply("Не нашёл ключевых слов. Укажите хотя бы одно слово или фразу.");
        return;
      }

      draft.matchMode = "keywords";
      draft.keywords = keywords;
      instagramReelDrafts.set(ctx.from.id, draft);
      adminStates.set(ctx.from.id, { mode: "instagram_reel_dm" });
      await ctx.reply(
        `Ключевые слова: ${keywords.join(", ")}\n\nТеперь отправьте текст сообщения для Instagram Direct.`,
        { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
      );
      return;
    }

    if (state.mode === "instagram_reel_dm") {
      const draft = instagramReelDrafts.get(ctx.from.id);
      if (!draft?.telegramFileId || !draft.matchMode) {
        adminStates.delete(ctx.from.id);
        instagramReelDrafts.delete(ctx.from.id);
        await ctx.reply("Черновик Reels устарел. Начните публикацию заново.");
        return;
      }

      const dmText = ctx.message.text.trim();
      if (!dmText || dmText.startsWith("/")) {
        await ctx.reply("Отправьте обычный текст сообщения для Direct.");
        return;
      }
      if (dmText.length > 1000) {
        await ctx.reply("Сообщение слишком длинное. Максимум 1000 символов.");
        return;
      }

      draft.dmText = dmText;
      instagramReelDrafts.set(ctx.from.id, draft);
      adminStates.delete(ctx.from.id);
      await showInstagramReelPreview(bot, ctx.from.id, draft);
      return;
    }

    if (state.mode === "instagram_media_id") {
      const mediaId = ctx.message.text.trim();
      if (!/^\d{5,40}$/.test(mediaId)) {
        await ctx.reply("Нужен числовой Instagram Media ID. Попробуйте ещё раз или нажмите «Отмена».");
        return;
      }

      const draft = instagramDrafts.get(ctx.from.id) ?? { keywords: [] };
      draft.scope = "media";
      draft.mediaId = mediaId;
      instagramDrafts.set(ctx.from.id, draft);
      adminStates.delete(ctx.from.id);

      await ctx.reply("На какие комментарии реагировать?", {
        reply_markup: instagramTriggerKeyboard()
      });
      return;
    }

    if (state.mode === "instagram_keywords") {
      const keywords = normalizeKeywordList(ctx.message.text);
      if (!keywords.length) {
        await ctx.reply("Не нашёл ключевых слов. Укажите хотя бы одно слово или фразу.");
        return;
      }

      const draft = instagramDrafts.get(ctx.from.id);
      if (!draft?.scope) {
        adminStates.delete(ctx.from.id);
        instagramDrafts.delete(ctx.from.id);
        await ctx.reply("Создание правила устарело. Откройте Instagram автоответчик и начните заново.");
        return;
      }

      draft.matchMode = "keywords";
      draft.keywords = keywords;
      instagramDrafts.set(ctx.from.id, draft);
      adminStates.set(ctx.from.id, { mode: "instagram_dm" });

      await ctx.reply(
        `Ключевые слова: ${keywords.join(", ")}\n\nТеперь отправьте текст сообщения для Instagram Direct.`,
        { reply_markup: new InlineKeyboard().text("❌ Отмена", "panel:cancel") }
      );
      return;
    }

    if (state.mode === "instagram_dm") {
      const dmText = ctx.message.text.trim();
      if (!dmText || dmText.startsWith("/")) {
        await ctx.reply("Отправьте обычный текст сообщения для Direct.");
        return;
      }
      if (dmText.length > 1000) {
        await ctx.reply("Сообщение слишком длинное. Максимум 1000 символов.");
        return;
      }

      const draft = instagramDrafts.get(ctx.from.id);
      if (!draft?.scope || !draft.matchMode) {
        adminStates.delete(ctx.from.id);
        instagramDrafts.delete(ctx.from.id);
        await ctx.reply("Создание правила устарело. Откройте Instagram автоответчик и начните заново.");
        return;
      }

      const name = draft.scope === "all_media"
        ? "Все новые публикации"
        : `Публикация ${draft.mediaId}`;

      const rule = await createInstagramAutomation({
        name,
        scope: draft.scope,
        mediaId: draft.mediaId ?? null,
        matchMode: draft.matchMode,
        keywords: draft.keywords,
        dmText,
        createdBy: ctx.from.id
      });

      adminStates.delete(ctx.from.id);
      instagramDrafts.delete(ctx.from.id);

      await ctx.reply(
        `✅ Правило #${rule.id} создано как выключенное. Проверьте настройки и включите его, когда Meta API будет подключён.`
      );
      await showInstagramRule(bot, ctx.from.id, rule.id);
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
      ctx.chat.id === paidChatId
    ) {
      try {
        await rememberCurrentChatMember(
          paidChatId,
          ctx.from.id,
          "message"
        );
      } catch (error) {
        console.warn("Could not remember paid chat member from message", {
          userId: ctx.from.id,
          error
        });
      }
    }
    await next();
  });

  bot.on("chat_member", async (ctx, next) => {
    const paidChatId = await getPaidChatId();
    if (paidChatId && ctx.chatMember.chat.id === paidChatId) {
      const member = ctx.chatMember.new_chat_member;
      const user = member.user;
      const active =
        member.status === "member" ||
        member.status === "administrator" ||
        member.status === "creator" ||
        (member.status === "restricted" && member.is_member);

      if (!user.is_bot) {
        try {
          if (active) {
            await rememberCurrentChatMember(
              paidChatId,
              user.id,
              "chat_member"
            );
          } else {
            await forgetCurrentChatMember(paidChatId, user.id);
          }
        } catch (error) {
          console.warn("Could not update paid chat member state", {
            userId: user.id,
            status: member.status,
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
