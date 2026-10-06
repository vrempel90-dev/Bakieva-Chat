import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminStatsForDays,
  dueForReminder,
  dueAccessDeliveries,
  existingUserIds,
  expiredSubscriptions,
  getCurrentChatMemberIds,
  getLegacy5000UsersDueForRenewal,
  getSetting,
  getPaidChatId,
  getUserLanguage,
  markExpired,
  markReminded,
  setSetting
} from "./db.js";
import { removeAccess, sendAccess } from "./access.js";
import { formatAdminReport } from "./admin_reports.js";
import { c, localeFor } from "./i18n.js";
import { sendLegacy5000ClaimNotice } from "./legacy_pricing.js";

export let schedulerActive = false;

function localReportState() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.ADMIN_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? "";

  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour"))
  };
}

async function sendDailyAdminReport(bot: Bot) {
  if (config.adminIds.size === 0) return;

  const state = localReportState();
  if (state.hour < config.ADMIN_REPORT_HOUR) return;

  const lastSent = await getSetting("daily_admin_report_last_date", "");
  if (lastSent === state.date) return;

  const configuredAdminIds = [...config.adminIds];
  const reachableAdminIds = await existingUserIds(configuredAdminIds);

  if (reachableAdminIds.length === 0) {
    console.warn(
      "Daily admin report skipped: no configured admin has started the bot yet",
      { configuredAdminIds }
    );
    await setSetting("daily_admin_report_last_date", state.date);
    return;
  }

  const stats = await adminStatsForDays(1);
  const text = formatAdminReport(stats, "итоги дня");
  const reportKeyboard = new InlineKeyboard()
    .text("👥 Клиенты / оплаты", "panel:clients:all:0")
    .row()
    .text("📊 Статистика", "panel:stats:1");

  let delivered = 0;
  for (const adminId of reachableAdminIds) {
    try {
      await bot.api.sendMessage(adminId, text, {
        parse_mode: "HTML",
        reply_markup: reportKeyboard
      });
      delivered++;
    } catch (error) {
      console.error("Daily admin report failed", { adminId, error });
    }
  }

  if (delivered > 0) {
    await setSetting("daily_admin_report_last_date", state.date);
  }
}

async function sendLegacyOct11Reminders(bot: Bot) {
  const state = localReportState();
  const paymentDate = "2026-10-11";
  if (state.date < paymentDate) return;
  if (state.date === paymentDate && state.hour < 9) return;

  const paidChatId = await getPaidChatId();
  const me = await bot.api.getMe();
  const claimUrl = `https://t.me/${me.username}?start=legacy5000`;

  const groupSent = await getSetting("legacy_oct11_group_sent_at", "");
  if (!groupSent && paidChatId) {
    try {
      await bot.api.sendMessage(
        paidChatId,
        [
          "💳 Сегодня, 11 октября, день продления для старых участников Bakieva Chat.",
          "",
          "Если вы были в чате до перехода на новые цены, ваш тариф остаётся 5 000 ₸ за 30 дней.",
          "Нажмите кнопку ниже: бот проверит ваш Telegram-аккаунт, сохранит старый тариф и откроет оплату.",
          "",
          "Новые участники оплачивают по новым тарифам: 10 000 ₸ / 30 дней или 25 000 ₸ / 5 месяцев.",
          "",
          "💳 Бүгін, 11 қазан — бұрынғы Bakieva Chat қатысушылары үшін ұзарту күні.",
          "Бұрынғы тарифіңіз — 30 күнге 5 000 ₸ — сақталады."
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard().url(
            "💗 Продлить за 5 000 ₸",
            claimUrl
          )
        }
      );
      await setSetting("legacy_oct11_group_sent_at", new Date().toISOString());
    } catch (error) {
      console.error("Legacy October 11 group reminder failed", error);
    }
  }

  const dmSent = await getSetting("legacy_oct11_dm_sent_at", "");
  if (dmSent) return;

  const userIds = await getLegacy5000UsersDueForRenewal();
  let delivered = 0;
  let failed = 0;

  for (const userId of userIds) {
    if (config.adminIds.has(userId)) continue;
    try {
      const lang = await getUserLanguage(userId);
      const text = lang === "ru"
        ? [
            "💗 Ваш тариф 5 000 ₸ сохранён",
            "",
            "Сегодня, 11 октября, дата продления Bakieva Chat.",
            "Для вас стоимость остаётся 5 000 ₸ за 30 дней.",
            "",
            "Нажмите кнопку ниже, чтобы продлить доступ."
          ].join("\n")
        : [
            "💗 5 000 ₸ тарифіңіз сақталды",
            "",
            "Бүгін, 11 қазан — Bakieva Chat жазылымын ұзарту күні.",
            "Сіз үшін баға 30 күнге 5 000 ₸ болып қалады.",
            "",
            "Қолжетімділікті ұзарту үшін төмендегі батырманы басыңыз."
          ].join("\n");

      await bot.api.sendMessage(
        userId,
        text,
        {
          reply_markup: new InlineKeyboard().text(
            lang === "ru" ? "💳 Оплатить 5 000 ₸" : "💳 5 000 ₸ төлеу",
            "pay:plan:legacy_monthly"
          )
        }
      );
      delivered++;
    } catch (error) {
      failed++;
      console.warn("Legacy October 11 DM failed", { userId, error });
    }
    await new Promise(resolve => setTimeout(resolve, 75));
  }

  await setSetting("legacy_oct11_dm_sent_at", new Date().toISOString());
  await setSetting("legacy_oct11_dm_stats", JSON.stringify({
    due: userIds.length,
    delivered,
    failed
  }));
}

const COMMUNITY_RENEWAL_DATE = "2026-10-22";

async function sendCommunityRenewalNotice(bot: Bot) {
  const state = localReportState();
  if (state.date < COMMUNITY_RENEWAL_DATE) return;

  const paidChatId = await getPaidChatId();
  if (!paidChatId) return;

  const me = await bot.api.getMe();
  const botUrl = `https://t.me/${me.username}`;

  const groupSent = await getSetting("community_renewal_2026_10_22_sent_at", "");
  if (!groupSent) {
    await bot.api.sendMessage(
      paidChatId,
      [
        "💳 Напоминание о продлении Bakieva Chat",
        "",
        "Текущий период участия подходит к концу. Чтобы сохранить доступ к рецептам, урокам, эфирам и сообществу, пожалуйста, продлите подписку через бота.",
        "",
        "💳 Bakieva Chat жазылымын ұзарту туралы еске салу",
        "",
        "Қазіргі қатысу кезеңі аяқталуға жақын. Рецепттерге, сабақтарға, эфирлерге және қауымдастыққа қолжетімділікті сақтау үшін жазылымды бот арқылы ұзартыңыз."
      ].join("\n"),
      {
        reply_markup: new InlineKeyboard().url(
          "💳 Продлить / Ұзарту",
          botUrl
        )
      }
    );
    await setSetting("community_renewal_2026_10_22_sent_at", new Date().toISOString());
  }

  const dmSent = await getSetting("community_renewal_2026_10_22_dm_sent_at", "");
  if (dmSent) return;

  const memberIds = await getCurrentChatMemberIds(paidChatId);
  let delivered = 0;
  let failed = 0;

  for (const userId of memberIds) {
    if (config.adminIds.has(userId)) continue;
    try {
      const lang = await getUserLanguage(userId);
      const ui = c(lang);
      const text = lang === "ru"
        ? [
            "💳 Напоминание о продлении Bakieva Chat",
            "",
            "Ваш текущий период участия подходит к концу.",
            "Чтобы сохранить доступ к материалам и сообществу, продлите подписку."
          ].join("\n")
        : [
            "💳 Bakieva Chat жазылымын ұзарту туралы еске салу",
            "",
            "Қазіргі қатысу кезеңіңіз аяқталуға жақын.",
            "Материалдар мен қауымдастыққа қолжетімділікті сақтау үшін жазылымды ұзартыңыз."
          ].join("\n");

      await bot.api.sendMessage(
        userId,
        text,
        { reply_markup: new InlineKeyboard().text(ui.renewButton, "pay:start") }
      );
      delivered++;
    } catch (error) {
      failed++;
      console.warn("Community renewal DM failed", { userId, error });
    }
    await new Promise(resolve => setTimeout(resolve, 60));
  }

  await setSetting("community_renewal_2026_10_22_dm_sent_at", new Date().toISOString());
  await setSetting("community_renewal_2026_10_22_dm_stats", JSON.stringify({
    tracked: memberIds.length,
    delivered,
    failed
  }));
}

async function run(bot: Bot) {
  try {
    await sendLegacy5000ClaimNotice(bot);
  } catch (error) {
    console.error("Legacy 5000 claim notice failed", error);
  }

  try {
    await sendLegacyOct11Reminders(bot);
  } catch (error) {
    console.error("Legacy October 11 reminders failed", error);
  }

  try {
    await sendCommunityRenewalNotice(bot);
  } catch (error) {
    console.error("Community renewal scheduler failed", error);
  }

  const reminder = await dueForReminder();
  for (const sub of reminder) {
    try {
      const lang = await getUserLanguage(sub.userId);
      const ui = c(lang);
      const kb = new InlineKeyboard().text(ui.renewButton, "pay:start");
      await bot.api.sendMessage(
        sub.userId,
        ui.reminder(sub.activeUntil.toLocaleDateString(localeFor(lang))),
        { reply_markup: kb }
      );
      await markReminded(sub.userId);
    } catch (error) {
      console.error("Reminder failed", { userId: sub.userId, error });
    }
  }

  await sendDailyAdminReport(bot);

  const expired = await expiredSubscriptions();
  for (const userId of expired) {
    try {
      await removeAccess(bot, userId);
      if (!await markExpired(userId)) continue;
      const lang = await getUserLanguage(userId);
      const ui = c(lang);
      const kb = new InlineKeyboard().text(ui.returnButton, "pay:start");
      await bot.api.sendMessage(
        userId,
        ui.expired,
        { reply_markup: kb }
      );
    } catch (error) {
      console.error("Expiry message failed", { userId, error });
    }
  }

  for (const entry of await dueAccessDeliveries()) {
    try { await sendAccess(bot, entry.userId, entry.activeUntil); }
    catch (error) { console.warn("access_retry_failed", { userId: entry.userId, error }); }
  }
}

export function startScheduler(bot: Bot) {
  if (schedulerActive) throw new Error("Scheduler already started in this instance");
  schedulerActive = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await run(bot); }
    catch (error) { console.error("scheduler_run_failed", error); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), 10 * 60 * 1000);
  timer.unref();
  return () => { clearInterval(timer); schedulerActive = false; };
}
