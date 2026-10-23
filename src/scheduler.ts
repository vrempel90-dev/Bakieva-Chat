import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminStatsForDays,
  dueForReminder,
  dueAccessDeliveries,
  existingUserIds,
  expiredSubscriptions,
  getSetting,
  getUserLanguage,
  markExpired,
  markReminded,
  setSetting
} from "./db.js";
import { removeAccess, sendAccess } from "./access.js";
import { formatAdminReport } from "./admin_reports.js";
import { c, localeFor } from "./i18n.js";

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

async function run(bot: Bot) {
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
