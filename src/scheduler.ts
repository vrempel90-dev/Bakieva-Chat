import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  dueForReminder,
  expiredSubscriptions,
  markReminded,
  pool,
} from "./db.js";
import { expireAccess, sendAccess } from "./access.js";
import { dailyReports } from "./sales.js";

export async function runScheduler(bot: Bot) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked = Boolean(
      (await client.query("SELECT pg_try_advisory_lock(424201002) AS locked"))
        .rows[0].locked,
    );
    if (!locked) return;
    for (const sub of await dueForReminder()) {
      try {
        await bot.api.sendMessage(
          sub.userId,
          `⏳ Подписка заканчивается ${sub.activeUntil.toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })} (Алматы).`,
          {
            reply_markup: new InlineKeyboard().text(
              "Продлить подписку",
              "pay:start",
            ),
          },
        );
        await markReminded(sub.userId);
      } catch {
        console.warn("Reminder failed", { userId: sub.userId });
      }
    }
    for (const userId of await expiredSubscriptions()) {
      try {
        if (await expireAccess(bot, userId)) {
          try {
            await bot.api.sendMessage(
              userId,
              "Доступ закрыт. Вернуться: выберите тариф через меню.",
              {
                reply_markup: new InlineKeyboard().text(
                  "Вернуться в Bakieva Chat",
                  "pay:start",
                ),
              },
            );
          } catch {
            /* Access removal is committed. */
          }
        }
      } catch {
        console.warn("Expiry failed; will retry", { userId });
      }
    }
    const ready = await client.query(
      "SELECT DISTINCT user_id FROM payments WHERE status='approved' AND access_status='ready' AND user_id IS NOT NULL",
    );
    for (const row of ready.rows) {
      try {
        await sendAccess(bot, Number(row.user_id));
      } catch {
        console.warn("Access delivery failed; will retry", {
          userId: row.user_id,
        });
      }
    }
    await dailyReports(bot);
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(424201002)");
    } finally {
      client.release();
    }
  }
}
export function startScheduler(bot: Bot) {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = runScheduler(bot)
      .catch(() => console.warn("Scheduler failed; will retry"))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
