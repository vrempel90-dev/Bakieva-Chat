import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminClientCounts,
  adminStatsForDays,
  createContentDraft,
  deleteContentPost,
  getActiveNotificationUsers,
  getContentPost,
  currentChatMemberStats,
  forgetCurrentChatMember,
  getLegacyMembers,
  getMarketingUsers,
  getPrice,
  getPayment,
  getActiveSubscription,
  getAdminClient,
  getPaidChannelId,
  getPaidChatId,
  getPaidMainChatId,
  getSetting,
  getUserLanguage,
  legacyPriceEligibleCount,
  legacyStats,
  listAdminClientPayments,
  listAdminClients,
  listContentPosts,
  markContentNotified,
  publishContentPost,
  publishTrialVideoPair,
  rememberCurrentChatMember,
  registerLegacyMember,
  registerLegacyMembers,
  setPaidChannelId,
  setPaidChatId,
  setPaidMainChatId,
  setContentDraftMedia,
  setSetting,
  pool,
  LEGACY_EXPIRES_AT,
  type AdminClient,
  type AdminClientFilter
} from "./db.js";
import { formatAdminReport } from "./admin_reports.js";
import { c, localeFor } from "./i18n.js";
import { sendAccess } from "./access.js";
import { schedulerActive } from "./scheduler.js";
import { sendLegacy5000ClaimNotice } from "./legacy_pricing.js";
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

type TrialVideoDraftPart = {
  fileId: string;
  mediaType: "video" | "document";
};

const adminStates = new Map<number, AdminState>();
const trialVideoDrafts = new Map<number, { ruPart1?: TrialVideoDraftPart; kkPart1?: TrialVideoDraftPart }>();
const instagramDrafts = new Map<number, InstagramDraft>();
const instagramReelDrafts = new Map<number, InstagramReelDraft>();
const pendingNewsDrafts = new Map<number, number>();

async function handleTrialVideoDocumentUpload(
  bot: Bot,
  adminId: number,
  language: "ru" | "kk",
  part: "part1" | "part2",
  uploaded: TrialVideoDraftPart,
  fileUniqueId: string
) {
  const key = language === "ru" ? "ruPart1" : "kkPart1";
  const nextState = language === "ru" ? "trial_video_ru_part2" : "trial_video_kk_part2";
  const resetState = language === "ru" ? "trial_video_ru_part1" : "trial_video_kk_part1";

  if (part === "part1") {
    trialVideoDrafts.set(
      adminId,
      language === "ru" ? { ruPart1: uploaded } : { kkPart1: uploaded }
    );
    adminStates.set(adminId, { mode: nextState });
    await bot.api.sendMessage(
      adminId,
      language === "ru"
        ? "✅ Часть 1 принята как файл без перекодирования. Теперь пришлите ЧАСТЬ 2 также как файл."
        : "✅ 1-бөлім файл ретінде қабылданды. Енді 2-БӨЛІМДІ де файл ретінде жіберіңіз.",
      { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
    );
    return;
  }

  const first = trialVideoDrafts.get(adminId)?.[key];
  if (!first) {
    adminStates.set(adminId, { mode: resetState });
    await bot.api.sendMessage(
      adminId,
      language === "ru"
        ? "Черновик первой части потерян. Пришлите часть 1 ещё раз."
        : "1-бөлімнің черновигі жоғалды. 1-бөлімді қайта жіберіңіз."
    );
    return;
  }

  await publishTrialVideoPair(language, first.fileId, uploaded.fileId, {
    part1: first.mediaType,
    part2: uploaded.mediaType
  });

  trialVideoDrafts.delete(adminId);
  adminStates.delete(adminId);

  console.info("Trial video replaced with original-quality document parts", {
    adminId,
    language,
    part2FileUniqueId: fileUniqueId
  });

  await bot.api.sendMessage(
    adminId,
    language === "ru"
      ? "✅ Русский пробный урок заменён. Обе части сохранены и выдаются как файлы без повторного перекодирования ботом."
      : "✅ Қазақша сынақ сабағы ауыстырылды. Екі бөлік те файл ретінде сақталып, ботпен қайта кодталмай беріледі.",
    { reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home") }
  );
}

function isAdmin(id?: number) {
  return typeof id === "number" && config.adminIds.has(id);
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function adminHomeKeyboard() {
  return new InlineKeyboard()
    .text("📊 Статистика", "panel:stats:1")
    .text("👥 Клиенты / оплаты", "panel:clients:all:0")
    .row()
    .text("💰 Тарифы / Kaspi", "panel:price")
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
    .text("⚙️ Привязать чат и канал", "panel:targets")
    .row()
    .text("🛠 Диагностика", "panel:diagnostics")
    .text("🔄 Повторно выдать доступ", "panel:retry:help");
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

const ADMIN_CLIENT_PAGE_SIZE = 8;

function adminClientFilterLabel(filter: AdminClientFilter) {
  if (filter === "paid") return "оплатили";
  if (filter === "unpaid") return "не оплатили";
  if (filter === "pending") return "ожидают оплаты/проверки";
  if (filter === "expiring") return "подписка заканчивается ≤ 3 дней";
  return "все клиенты";
}

function adminClientName(client: AdminClient) {
  const name = [client.firstName, client.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  if (client.username) return `@${client.username.replace(/^@/, "")}`;
  return `ID ${client.telegramId}`;
}

function shortAdminClientName(value: string, max = 30) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function adminClientBadge(client: AdminClient) {
  if (client.hasPendingPayment) return "⏳";
  if (client.isExpiring) return "⚠️";
  if (client.approvedPayments > 0) return "✅";
  return "❌";
}

function adminDate(value: Date | null, withTime = false) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: config.ADMIN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {})
  }).format(value);
}

function adminClientContactUrl(client: AdminClient) {
  if (client.username) {
    return `https://t.me/${client.username.replace(/^@/, "")}`;
  }
  return `tg://user?id=${client.telegramId}`;
}

function adminClientPaymentStatus(status: string | null) {
  if (status === "approved") return "✅ подтверждён";
  if (status === "pending") return "⏳ ожидает проверки";
  if (status === "rejected") return "❌ отклонён";
  return "❌ подтверждённых оплат нет";
}

async function showAdminClients(
  bot: Bot,
  userId: number,
  filter: AdminClientFilter,
  page: number,
  edit?: (text: string, options: any) => Promise<unknown>
) {
  const counts = await adminClientCounts();
  const total = counts[filter];
  const pages = Math.max(1, Math.ceil(total / ADMIN_CLIENT_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(Math.trunc(page), pages - 1));
  const clients = await listAdminClients(
    filter,
    ADMIN_CLIENT_PAGE_SIZE,
    safePage * ADMIN_CLIENT_PAGE_SIZE
  );

  const text = [
    "👥 Клиенты / оплаты",
    "",
    `Всего клиентов: ${counts.all}`,
    `✅ Оплатили: ${counts.paid}`,
    `❌ Не оплатили: ${counts.unpaid}`,
    `⏳ Ожидают оплаты/проверки: ${counts.pending}`,
    `⚠️ Заканчивается ≤ 3 дней: ${counts.expiring}`,
    "",
    `Фильтр: ${adminClientFilterLabel(filter)}`,
    `Страница: ${safePage + 1}/${pages}`,
    "",
    clients.length
      ? "Нажмите на клиента, чтобы открыть карточку и контакт."
      : "По этому фильтру клиентов нет."
  ].join("\n");

  const kb = new InlineKeyboard()
    .text(`Все ${counts.all}`, "panel:clients:all:0")
    .text(`✅ ${counts.paid}`, "panel:clients:paid:0")
    .row()
    .text(`❌ ${counts.unpaid}`, "panel:clients:unpaid:0")
    .text(`⏳ ${counts.pending}`, "panel:clients:pending:0")
    .row()
    .text(`⚠️ До 3 дней ${counts.expiring}`, "panel:clients:expiring:0");

  for (const client of clients) {
    kb.row().text(
      `${adminClientBadge(client)} ${shortAdminClientName(adminClientName(client))}`,
      `panel:client:${client.telegramId}:${filter}:${safePage}`
    );
  }

  if (pages > 1) {
    kb.row();
    if (safePage > 0) {
      kb.text("⬅️ Назад", `panel:clients:${filter}:${safePage - 1}`);
    }
    if (safePage + 1 < pages) {
      kb.text("Вперёд ➡️", `panel:clients:${filter}:${safePage + 1}`);
    }
  }

  kb.row().text("🏠 Админка", "panel:home");

  const options = { reply_markup: kb };
  if (edit) {
    await edit(text, options);
    return;
  }
  await bot.api.sendMessage(userId, text, options);
}

async function showAdminClientCard(
  bot: Bot,
  userId: number,
  clientId: number,
  filter: AdminClientFilter,
  page: number,
  edit?: (text: string, options: any) => Promise<unknown>
) {
  const client = await getAdminClient(clientId);
  if (!client) {
    const text = "Клиент не найден.";
    const options = {
      reply_markup: new InlineKeyboard()
        .text("⬅️ К списку", `panel:clients:${filter}:${page}`)
        .row()
        .text("🏠 Админка", "panel:home")
    };
    if (edit) await edit(text, options);
    else await bot.api.sendMessage(userId, text, options);
    return;
  }

  const username = client.username
    ? `@${client.username.replace(/^@/, "")}`
    : "не указан";
  const subscription = client.isActive
    ? `${client.isExpiring ? "⚠️" : "✅"} активна до ${adminDate(client.activeUntil)}`
    : client.subscriptionStatus
      ? `❌ ${client.subscriptionStatus}`
      : "—";

  const text = [
    `👤 ${adminClientName(client)}`,
    "",
    `Telegram ID: ${client.telegramId}`,
    `Username: ${username}`,
    `Регистрация: ${adminDate(client.createdAt, true)}`,
    "",
    `Оплата: ${client.hasPendingPayment ? "⏳ есть платёж на проверке" : adminClientPaymentStatus(client.latestPaymentStatus)}`,
    `Успешных оплат: ${client.approvedPayments}`,
    `Всего подтверждено: ${client.totalApprovedAmount.toLocaleString("ru-RU")} ₸`,
    `Последняя подтверждённая оплата: ${adminDate(client.lastApprovedAt, true)}`,
    `Подписка: ${subscription}`
  ].join("\n");

  const kb = new InlineKeyboard()
    .url("💬 Открыть Telegram", adminClientContactUrl(client))
    .row()
    .text("💳 История оплат", `panel:clientpay:${client.telegramId}:${filter}:${page}`)
    .row()
    .text("⬅️ К списку", `panel:clients:${filter}:${page}`)
    .text("🏠 Админка", "panel:home");

  const options = { reply_markup: kb };
  if (edit) {
    await edit(text, options);
    return;
  }
  await bot.api.sendMessage(userId, text, options);
}

async function showAdminClientPayments(
  bot: Bot,
  userId: number,
  clientId: number,
  filter: AdminClientFilter,
  page: number,
  edit?: (text: string, options: any) => Promise<unknown>
) {
  const [client, payments] = await Promise.all([
    getAdminClient(clientId),
    listAdminClientPayments(clientId, 10)
  ]);

  const title = client ? adminClientName(client) : `ID ${clientId}`;
  const rows = payments.map(payment => {
    const icon = payment.status === "approved"
      ? "✅"
      : payment.status === "pending"
        ? "⏳"
        : "❌";
    return `${icon} #${payment.id} • ${payment.amount.toLocaleString("ru-RU")} ₸ • ${adminDate(payment.approvedAt ?? payment.requestedAt, true)}`;
  });

  const text = [
    `💳 История оплат — ${title}`,
    "",
    ...(rows.length ? rows : ["Платежей пока нет."]),
    "",
    "Показаны последние 10 операций."
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("⬅️ К карточке", `panel:client:${clientId}:${filter}:${page}`)
    .row()
    .text("👥 К списку", `panel:clients:${filter}:${page}`)
    .text("🏠 Админка", "panel:home");

  const options = { reply_markup: kb };
  if (edit) {
    await edit(text, options);
    return;
  }
  await bot.api.sendMessage(userId, text, options);
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
    const options = {
      caption: post.body?.slice(0, 1000) || "Предпросмотр видео",
      reply_markup: publishKeyboard(post.id)
    };
    if (post.telegramMediaType === "document") {
      await bot.api.sendDocument(userId, post.telegramFileId, options);
    } else {
      await bot.api.sendVideo(userId, post.telegramFileId, options);
    }
    return;
  }

  if (post.kind === "news" && post.telegramFileId && post.telegramMediaType === "photo") {
    await bot.api.sendPhoto(userId, post.telegramFileId, {
      caption: post.body?.slice(0, 1000) || "Предпросмотр новости",
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
      const notificationsKeyboard = new InlineKeyboard().text(
        ui.notificationsOffButton,
        "marketing:off"
      );
      if (published.kind === "video" && published.telegramFileId) {
        const caption = [
          ui.newVideo,
          published.body?.trim() ?? ""
        ].filter(Boolean).join("\n\n").slice(0, 1000);
        if (published.telegramMediaType === "document") {
          await bot.api.sendDocument(userId, published.telegramFileId, {
            caption,
            reply_markup: notificationsKeyboard
          });
        } else {
          await bot.api.sendVideo(userId, published.telegramFileId, {
            caption,
            reply_markup: notificationsKeyboard
          });
        }
      } else if (
        published.kind === "news" &&
        published.telegramFileId &&
        published.telegramMediaType === "photo"
      ) {
        const body = published.body?.trim() || ui.newNewsFallback;
        await bot.api.sendPhoto(userId, published.telegramFileId, {
          caption: `${ui.newNews}\n\n${body}`.slice(0, 1000),
          reply_markup: notificationsKeyboard
        });
      } else {
        const body = published.body?.trim() || ui.newNewsFallback;
        await bot.api.sendMessage(
          userId,
          `${ui.newNews}\n\n${body}`,
          { reply_markup: notificationsKeyboard }
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
  const legacy5000Count = await legacyPriceEligibleCount();
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
    `💗 Тариф 5 000 ₸ уже закреплён: ${legacy5000Count}`,
    `Бот уже запомнил активных участников: ${trackedActive}`,
    `Всего замечено ботом: ${trackedSeen}`,
    "",
    "Старые участники могут закрепить тариф 5 000 ₸ через специальную кнопку в текущем платном чате.",
    "Перед закреплением бот проверяет фактическое членство этого Telegram ID в старом чате.",
    "Клиенты, уже оплатившие новые тарифы 10 000/25 000 ₸, автоматически в старую тарифную группу не переводятся."
  ].join("\n");

  const kb = new InlineKeyboard()
    .text("📣 Отправить кнопку 5 000 ₸", "legacy:5000notice")
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
  const [paidChatId, paidChannelId, paidMainChatId] = await Promise.all([
    getPaidChatId(),
    getPaidChannelId(),
    getPaidMainChatId()
  ]);

  await bot.api.sendMessage(
    userId,
    [
      "⚙️ Привязка платного чата и канала",
      "",
      `Платный чат: ${paidChatId || "не привязан"}`,
      `Основной платный чат для новых подписок: ${paidMainChatId || "не привязан"}`,
      `Платный канал: ${paidChannelId || "не привязан"}`,
      "",
      "Для чата: добавьте бота администратором в нужную группу и отправьте там команду /bind_chat.",
      "Для основного платного чата: отправьте там /bind_main_chat (только администратор бота).",
      "Для канала: добавьте бота администратором канала и опубликуйте в канале команду /bind_channel.",
      "",
      "После привязки бот сможет выдавать ссылки, проверять заявки и автоматически удалять участников с истёкшей подпиской."
    ].join("\n"),
    { reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home") }
  );
}

export function registerAdminPanel(bot: Bot) {
  bot.command("bind_main_chat", async ctx => {
    if (!isAdmin(ctx.from?.id) || !["group", "supergroup"].includes(ctx.chat.type)) return;
    try {
      const me = await bot.api.getMe();
      const member = await bot.api.getChatMember(ctx.chat.id, me.id);
      if (member.status !== "administrator" && member.status !== "creator") throw new Error("Бот не администратор");
      if (member.status === "administrator" && !member.can_invite_users) throw new Error("Нет права создавать ссылки");
      await setPaidMainChatId(ctx.chat.id);
      await ctx.reply("✅ Основной платный чат привязан для выдачи доступа после оплаты.");
    } catch (error) { await ctx.reply(`Не удалось привязать чат: ${String(error)}`); }
  });

  bot.callbackQuery("panel:diagnostics", async ctx => {
    if (!isAdmin(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Нет доступа" }); return; }
    await ctx.answerCallbackQuery();
    const rows: string[] = [];
    try { await pool.query("SELECT 1"); rows.push("PostgreSQL: OK"); }
    catch { rows.push("PostgreSQL: ERROR"); }
    try { await bot.api.getMe(); rows.push("Telegram API: OK"); }
    catch { rows.push("Telegram API: ERROR"); }
    const me = await bot.api.getMe().catch(() => null);
    const targets = [
      { label: "Paid Channel", id: await getPaidChannelId(), type: "channel" },
      { label: "Main Paid Chat", id: await getPaidMainChatId(), type: "group" }
    ];
    for (const target of targets) {
      let chatOk = false, admin = false, canInvite = false;
      try {
        if (target.id && me) {
          const chat = await bot.api.getChat(target.id);
          chatOk = target.type === "channel" ? chat.type === "channel" :
            chat.type === "group" || chat.type === "supergroup";
          const member = await bot.api.getChatMember(target.id, me.id);
          admin = member.status === "administrator" || member.status === "creator";
          canInvite = member.status === "creator" || (member.status === "administrator" && member.can_invite_users);
        }
      } catch { /* reflected in the diagnostic row */ }
      rows.push(`${target.label}: ${chatOk ? "OK" : "ERROR"}`,
        `Bot admin in ${target.label}: ${admin ? "YES" : "NO"}`,
        `Create invite ${target.label}: ${canInvite ? "YES" : "NO"}`);
    }
    rows.push("Poller: ACTIVE", `Scheduler: ${schedulerActive ? "ACTIVE" : "ERROR"}`);
    await bot.api.sendMessage(ctx.from.id, rows.join("\n"), {
      reply_markup: new InlineKeyboard().text("🏠 Админка", "panel:home")
    });
  });

  bot.callbackQuery("panel:retry:help", async ctx => {
    if (!isAdmin(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Нет доступа" }); return; }
    await ctx.answerCallbackQuery();
    await ctx.reply("Чтобы выдать доступ повторно без новой оплаты: /retry_access TELEGRAM_ID или /retry_payment PAYMENT_ID");
  });

  bot.command(["retry_access", "retry_payment"], async ctx => {
    if (!isAdmin(ctx.from?.id)) return;
    const id = Number(ctx.message?.text.trim().split(/\s+/)[1]);
    if (!Number.isSafeInteger(id) || id <= 0) { await ctx.reply("Укажите числовой ID."); return; }
    const payment = ctx.message?.text.startsWith("/retry_payment") ? await getPayment(id) : null;
    const userId = payment ? (payment.status === "approved" ? Number(payment.user_id) : 0) :
      ctx.message?.text.startsWith("/retry_payment") ? 0 : id;
    const until = userId ? await getActiveSubscription(userId) : null;
    if (!until) { await ctx.reply("Активная подписка не найдена."); return; }
    try { await sendAccess(bot, userId, until); await ctx.reply(`Доступ для ${userId} отправлен повторно.`); }
    catch { await ctx.reply(`Подписка ${userId} активна, но выдача доступа пока не удалась. Проверьте диагностику.`); }
  });
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
    if (!from) return;
    if (!isAdmin(from.id)) {
      console.info(JSON.stringify({ event: "admin_access_denied", userId: from.id }));
      await ctx.reply(`Для этого аккаунта не настроен доступ к админке. Ваш Telegram ID: ${from.id}. Передайте его владельцу бота.`);
      return;
    }
    adminStates.delete(from.id);
    trialVideoDrafts.delete(from.id);
    instagramDrafts.delete(from.id);
    instagramReelDrafts.delete(from.id);
    pendingNewsDrafts.delete(from.id);
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
    pendingNewsDrafts.delete(ctx.from.id);
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

  bot.callbackQuery(/^panel:clients:(all|paid|unpaid|pending|expiring):(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const filter = ctx.match[1] as AdminClientFilter;
    const page = Number(ctx.match[2]);
    await ctx.answerCallbackQuery();
    await showAdminClients(
      bot,
      ctx.from.id,
      filter,
      page,
      (text, options) => ctx.editMessageText(text, options)
    );
  });

  bot.callbackQuery(/^panel:client:(\d+):(all|paid|unpaid|pending|expiring):(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const clientId = Number(ctx.match[1]);
    const filter = ctx.match[2] as AdminClientFilter;
    const page = Number(ctx.match[3]);
    await ctx.answerCallbackQuery();
    await showAdminClientCard(
      bot,
      ctx.from.id,
      clientId,
      filter,
      page,
      (text, options) => ctx.editMessageText(text, options)
    );
  });

  bot.callbackQuery(/^panel:clientpay:(\d+):(all|paid|unpaid|pending|expiring):(\d+)$/, async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const clientId = Number(ctx.match[1]);
    const filter = ctx.match[2] as AdminClientFilter;
    const page = Number(ctx.match[3]);
    await ctx.answerCallbackQuery();
    await showAdminClientPayments(
      bot,
      ctx.from.id,
      clientId,
      filter,
      page,
      (text, options) => ctx.editMessageText(text, options)
    );
  });

  bot.callbackQuery("panel:price", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    const [legacyCount, kaspiUrl] = await Promise.all([
      legacyPriceEligibleCount(),
      getSetting("kaspi_pay_url", config.KASPI_PAY_URL)
    ]);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        "💰 Тарифы Bakieva Chat",
        "",
        "💗 Акционная группа: 5 000 ₸ / 30 дней",
        "💳 Новый клиент: 10 000 ₸ / 30 дней",
        "⭐ Новый клиент: 25 000 ₸ / 150 дней (5 месяцев)",
        `👥 Акционный тариф закреплён: ${legacyCount} чел.`,
        "",
        `Kaspi Pay: ${kaspiUrl}`,
        "",
        "Изменить льготный статус:",
        "/legacy_price TELEGRAM_ID on|off",
        "",
        "Изменить Kaspi-ссылку:",
        "/kaspi_url https://pay.kaspi.kz/pay/..."
      ].join("\n"),
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
    pendingNewsDrafts.delete(ctx.from.id);
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
        ? "🇷🇺 Пришлите ЧАСТЬ 1 нового русского пробного урока исходным ФАЙЛОМ. В Telegram: скрепка → Файл → выберите оригинал. Не отправляйте из галереи как обычное видео: оно может быть сжато ещё до получения ботом. После первой части бот попросит часть 2. Большие файлы не нужно уменьшать до 50 МБ: бот выдаёт уже загруженный файл по его ID."
        : "🇰🇿 Жаңа қазақша сынақ сабағының 1-БӨЛІМІН түпнұсқа ФАЙЛ ретінде жіберіңіз. Telegram: қыстырғыш → Файл → түпнұсқаны таңдаңыз. Галереядан кәдімгі видео ретінде жібермеңіз: ботқа жеткенше сығылуы мүмкін. Одан кейін бот 2-бөлімді сұрайды. Үлкен файлды 50 МБ-қа дейін кішірейтудің қажеті жоқ: бот жүктелген файлдың ID-сын пайдаланады.",
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
      "🎬 Пришлите видео одним сообщением. Для максимального качества отправляйте его как ФАЙЛ/Document (скрепка → Файл), а не как обычное видео. Если нужен текст — добавьте его в подпись.",
      { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("panel:new:news", async ctx => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    pendingNewsDrafts.delete(ctx.from.id);
    adminStates.set(ctx.from.id, { mode: "news" });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "📰 Можно отправить текст новости, а затем фото отдельным сообщением. Либо сразу отправьте фото с подписью. Бот покажет предпросмотр перед публикацией.",
      { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
    );
  });

  bot.callbackQuery("panel:cancel", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    adminStates.delete(ctx.from.id);
    trialVideoDrafts.delete(ctx.from.id);
    instagramDrafts.delete(ctx.from.id);
    instagramReelDrafts.delete(ctx.from.id);
    pendingNewsDrafts.delete(ctx.from.id);
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
    if (pendingNewsDrafts.get(ctx.from.id) === id) pendingNewsDrafts.delete(ctx.from.id);
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
    if (pendingNewsDrafts.get(ctx.from.id) === id) pendingNewsDrafts.delete(ctx.from.id);
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

  bot.callbackQuery("legacy:5000notice", async ctx => {
    if (!isAdmin(ctx.from.id)) return;
    await ctx.answerCallbackQuery({ text: "Отправляю кнопку старого тарифа…" });
    try {
      await sendLegacy5000ClaimNotice(bot, { force: true });
      const count = await legacyPriceEligibleCount();
      await ctx.reply(
        `✅ Сообщение «Сохранить тариф 5 000 ₸» отправлено в старый платный чат. Сейчас тариф уже закреплён за ${count} аккаунтами.`
      );
    } catch (error) {
      console.error("Legacy 5000 claim notice failed", error);
      await ctx.reply(
        "❌ Не удалось отправить сообщение. Проверьте привязку платного чата и права бота."
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
    if (state.mode.startsWith("trial_video_")) {
      await ctx.reply(
        state.mode.includes("_ru_")
          ? "⚠️ Эта часть пришла как обычное видео. Telegram мог сжать её до получения ботом. Для сохранения качества пришлите ту же часть исходным файлом: скрепка → Файл → выберите оригинал. Бот продолжает ждать эту часть; действующий урок не изменён."
          : "⚠️ Бұл бөлік кәдімгі видео ретінде келді. Telegram оны ботқа жеткенше сығуы мүмкін. Сапаны сақтау үшін осы бөліктің түпнұсқасын файл ретінде жіберіңіз: қыстырғыш → Файл. Бот осы бөлікті күтеді; қолданыстағы сабақ өзгерген жоқ.",
        { reply_markup: new InlineKeyboard().text("Отмена", "panel:cancel") }
      );
      return;
    }
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

    const caption = ctx.message.caption?.trim() ?? "";
    const draft = await createContentDraft({
      kind: "video",
      title: caption.split("\n")[0]?.slice(0, 120) || "Новое видео",
      body: caption,
      telegramFileId: video.file_id,
      telegramFileUniqueId: video.file_unique_id,
      telegramMediaType: "video",
      createdBy: ctx.from.id
    });

    await ctx.reply(`✅ Видео загружено как черновик #${draft.id}.`);
    await showDraft(bot, ctx.from.id, draft.id);
  });


  bot.on("message:photo", async (ctx, next) => {
    if (!isAdmin(ctx.from?.id)) {
      await next();
      return;
    }

    const state = adminStates.get(ctx.from.id);
    const pendingDraftId = pendingNewsDrafts.get(ctx.from.id);
    if (state?.mode !== "news" && !pendingDraftId) {
      await next();
      return;
    }

    const photo = ctx.message.photo.at(-1);
    if (!photo) {
      await next();
      return;
    }

    if (pendingDraftId) {
      const updated = await setContentDraftMedia(
        pendingDraftId,
        photo.file_id,
        photo.file_unique_id,
        "photo"
      );
      pendingNewsDrafts.delete(ctx.from.id);
      if (!updated) {
        await ctx.reply(
          "Этот черновик уже опубликован или удалён. Откройте «Добавить новость» и создайте новую публикацию."
        );
        return;
      }
      await ctx.reply(`✅ Фото добавлено к новости #${updated.id}.`);
      await showDraft(bot, ctx.from.id, updated.id);
      return;
    }

    adminStates.delete(ctx.from.id);
    const body = ctx.message.caption?.trim() ?? "";
    const draft = await createContentDraft({
      kind: "news",
      title: body.split("\n")[0]?.slice(0, 120) || "Новость",
      body,
      telegramFileId: photo.file_id,
      telegramFileUniqueId: photo.file_unique_id,
      telegramMediaType: "photo",
      createdBy: ctx.from.id
    });

    await ctx.reply(`✅ Новость с фото сохранена как черновик #${draft.id}.`);
    await showDraft(bot, ctx.from.id, draft.id);
  });

  bot.on("message:document", async (ctx, next) => {
    if (!isAdmin(ctx.from?.id)) {
      await next();
      return;
    }

    const state = adminStates.get(ctx.from.id);
    if (
      !state ||
      ![
        "video",
        "trial_video_ru_part1",
        "trial_video_ru_part2",
        "trial_video_kk_part1",
        "trial_video_kk_part2",
        "instagram_reel_video"
      ].includes(state.mode)
    ) {
      await next();
      return;
    }

    const document = ctx.message.document;
    const mimeType = document.mime_type ?? "";
    const fileName = document.file_name?.toLowerCase() ?? "";
    const looksLikeVideo =
      mimeType.startsWith("video/") ||
      fileName.endsWith(".mp4") ||
      fileName.endsWith(".mov") ||
      fileName.endsWith(".mkv") ||
      fileName.endsWith(".webm");

    if (!looksLikeVideo) {
      await ctx.reply(
        state.mode === "instagram_reel_video"
          ? "Для Reels нужен видеофайл MP4/MOV."
          : "Нужен видеофайл. Отправьте MP4/MOV/MKV/WebM как файл."
      );
      return;
    }

    if (
      state.mode === "instagram_reel_video" &&
      typeof document.file_size === "number" &&
      document.file_size > 20 * 1024 * 1024
    ) {
      await ctx.reply(
        "Этот файл больше 20 МБ. Через обычный Telegram Bot API бот не сможет скачать его для передачи в Instagram. Пришлите сжатую версию до 20 МБ."
      );
      return;
    }

    if (state.mode.startsWith("trial_video_")) {
      const language = state.mode.includes("_ru_") ? "ru" : "kk";
      const part = state.mode.endsWith("_part1") ? "part1" : "part2";
      await handleTrialVideoDocumentUpload(
        bot,
        ctx.from.id,
        language,
        part,
        { fileId: document.file_id, mediaType: "document" },
        document.file_unique_id
      );
      return;
    }

    adminStates.delete(ctx.from.id);
    const caption = ctx.message.caption?.trim() ?? "";

    if (state.mode === "video") {
      const draft = await createContentDraft({
        kind: "video",
        title: caption.split("\n")[0]?.slice(0, 120) || "Новое видео",
        body: caption,
        telegramFileId: document.file_id,
        telegramFileUniqueId: document.file_unique_id,
        telegramMediaType: "document",
        createdBy: ctx.from.id
      });
      await ctx.reply(
        `✅ Видео сохранено как файл без повторного перекодирования ботом. Черновик #${draft.id}.`
      );
      await showDraft(bot, ctx.from.id, draft.id);
      return;
    }

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
      pendingNewsDrafts.set(ctx.from.id, draft.id);
      await ctx.reply(
        `✅ Текст новости сохранён как черновик #${draft.id}. Если нужно фото — отправьте его сейчас отдельным сообщением. Если фото не нужно, можете сразу нажать кнопку публикации в предпросмотре ниже.`
      );
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
