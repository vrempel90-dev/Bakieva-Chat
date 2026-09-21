import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { config } from "./config.js";
import {
  adminStatsForDays,
  dueForReminder,
  existingUserIds,
  expiredSubscriptions,
  getSetting,
  getPaidChatId,
  markExpired,
  markReminded,
  setSetting,
  LEGACY_EXPIRES_AT
} from "./db.js";
import { removeAccess } from "./access.js";
import { formatAdminReport } from "./admin_reports.js";

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
          "",
          "Ваша действующая подписка заканчивается 12 октября 2026 года.",
          "Нажмите кнопку ниже, чтобы бот зарегистрировал ваш Telegram-аккаунт и смог автоматически напомнить о продлении.",
          "",
          "Если подписка не будет продлена, после окончания срока доступ в платный чат и канал будет закрыт."
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard().url(
            "✅ Зарегистрировать подписку",
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
            "",
            "Чтобы сохранить доступ после 12 октября, продлите подписку через бота.",
            "Участники без продления будут автоматически исключены из платного чата и канала после окончания зарегистрированного срока."
          ].join("\n"),
          {
            reply_markup: new InlineKeyboard().url(
              "💳 Продлить подписку",
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

async function run(bot: Bot) {
  try {
    await sendLegacyChatNotices(bot);
  } catch (error) {
    console.error("Legacy chat notice scheduler failed", error);
  }

  const reminder = await dueForReminder();
  for (const sub of reminder) {
    try {
      const kb = new InlineKeyboard().text("💳 Продлить подписку", "pay:start");
      await bot.api.sendMessage(
        sub.userId,
        `⏳ До окончания подписки осталось не больше 3 дней. Доступ действует до ${sub.activeUntil.toLocaleDateString("ru-RU")}.\n\nЧтобы не потерять доступ, продлите подписку.`,
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
      const kb = new InlineKeyboard().text("Вернуться в Bakieva Chat", "pay:start");
      await bot.api.sendMessage(
        userId,
        "Срок подписки закончился, поэтому доступ к платным материалам закрыт. Вы можете вернуться в Bakieva Chat в любой момент.",
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
