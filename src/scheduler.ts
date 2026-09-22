import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminStatsForDays,
  dueForReminder,
  existingUserIds,
  expiredSubscriptions,
  getCurrentChatMemberIds,
  getSetting,
  getPaidChatId,
  getUserLanguage,
  markExpired,
  markReminded,
  setSetting,
  LEGACY_EXPIRES_AT
} from "./db.js";
import { removeAccess } from "./access.js";
import { formatAdminReport } from "./admin_reports.js";
import { c, localeFor } from "./i18n.js";

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

  let delivered = 0;
  for (const adminId of reachableAdminIds) {
    try {
      await bot.api.sendMessage(adminId, text, { parse_mode: "HTML" });
      delivered++;
    } catch (error) {
      console.error("Daily admin report failed", { adminId, error });
    }
  }

  if (delivered > 0) {
    await setSetting("daily_admin_report_last_date", state.date);
  }
}

async function sendLegacyChatNotices(bot: Bot) {
  const now = Date.now();
  const expiresAt = LEGACY_EXPIRES_AT.getTime();
  if (now >= expiresAt) return;

  const paidChatId = await getPaidChatId();
  if (!paidChatId) return;

  const me = await bot.api.getMe();
  const botUrl = `https://t.me/${me.username}`;
  const registrationUrl = `${botUrl}?start=legacy2026`;

  const registrationSent = await getSetting("legacy_registration_notice_sent_at", "");
  if (!registrationSent) {
    try {
      await bot.api.sendMessage(
        paidChatId,
        [
          "⚠️ Важно для текущих участников Bakieva Chat",
          "Ваша действующая подписка заканчивается 12 октября 2026 года.",
          "Нажмите кнопку ниже, чтобы бот зарегистрировал ваш Telegram-аккаунт и смог заранее напомнить о продлении.",
          "Если подписка не будет продлена, доступ в платный чат и канал будет закрыт.",
          "",
          "⚠️ Bakieva Chat қатысушылары үшін маңызды",
          "Қолданыстағы жазылым 2026 жылғы 12 қазанда аяқталады.",
          "Төмендегі батырманы басып, Telegram аккаунтыңызды тіркеңіз. Бот жазылымды ұзарту туралы алдын ала еске салады.",
          "Жазылым ұзартылмаса, ақылы чат пен арнаға қолжетімділік жабылады."
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard().url(
            "✅ Регистрация / Тіркелу",
            registrationUrl
          )
        }
      );
      await setSetting("legacy_registration_notice_sent_at", new Date().toISOString());
    } catch (error) {
      console.error("Legacy registration chat notice failed", error);
    }
  }

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  if (now >= expiresAt - threeDaysMs) {
    const reminderSent = await getSetting("legacy_group_3day_reminder_sent_at", "");
    if (!reminderSent) {
      try {
        await bot.api.sendMessage(
          paidChatId,
          [
            "⏳ До окончания текущей подписки осталось не больше 3 дней.",
            "Чтобы сохранить доступ после 12 октября, продлите подписку через бота.",
            "Без продления доступ в платный чат и канал будет автоматически закрыт.",
            "",
            "⏳ Ағымдағы жазылымның аяқталуына 3 күннен аспайтын уақыт қалды.",
            "12 қазаннан кейін қолжетімділікті сақтау үшін жазылымды бот арқылы ұзартыңыз.",
            "Жазылым ұзартылмаса, ақылы чат пен арнаға қолжетімділік автоматты түрде жабылады."
          ].join("\n"),
          {
            reply_markup: new InlineKeyboard().url(
              "💳 Продлить / Ұзарту",
              botUrl
            )
          }
        );
        await setSetting("legacy_group_3day_reminder_sent_at", new Date().toISOString());
      } catch (error) {
        console.error("Legacy three-day group reminder failed", error);
      }
    }
  }
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
    await removeAccess(bot, userId);
    await markExpired(userId);
    try {
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
}

export function startScheduler(bot: Bot) {
  void run(bot);
  const timer = setInterval(() => void run(bot), 10 * 60 * 1000);
  timer.unref();
}
