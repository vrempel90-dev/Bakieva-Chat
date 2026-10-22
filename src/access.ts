import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import type pg from "pg";
import { config } from "./config.js";
import { eligible } from "./commerce.js";
import { withUserLock } from "./transaction.js";

export function paidTargets(): number[] {
  return [
    ...new Set(
      [config.paidChannelId, config.paidChatId].filter(
        (id): id is number => id !== undefined,
      ),
    ),
  ];
}
export async function sendAccess(bot: Bot, userId: number, _until?: Date) {
  return withUserLock(userId, async (c) => {
    if (!(await eligible(c, userId))) return false;
    const targets = paidTargets();
    if (!targets.length) throw new Error("Не настроены платные чаты");
    const kb = new InlineKeyboard();
    for (const chatId of targets) {
      let invite = (
        await c.query(
          `SELECT invite_link FROM access_invites WHERE user_id=$1 AND chat_id=$2
        AND expires_at>NOW()+interval '1 minute'`,
          [userId, chatId],
        )
      ).rows[0]?.invite_link;
      if (!invite) {
        const expiresAt = new Date(Date.now() + 3600000);
        const created = await bot.api.createChatInviteLink(chatId, {
          creates_join_request: true,
          expire_date: Math.floor(expiresAt.getTime() / 1000),
          name: `Bakieva ${userId}`.slice(0, 32),
        });
        invite = created.invite_link;
        await c.query(
          `INSERT INTO access_invites(user_id,chat_id,invite_link,expires_at) VALUES($1,$2,$3,$4)
          ON CONFLICT(user_id,chat_id) DO UPDATE SET invite_link=EXCLUDED.invite_link,expires_at=EXCLUDED.expires_at`,
          [userId, chatId, invite, expiresAt],
        );
      }
      kb.url(
        chatId === config.paidChannelId
          ? "📚 Закрытый канал"
          : "💬 Закрытый чат",
        invite,
      ).row();
    }
    const sub = (
      await c.query("SELECT active_until FROM subscriptions WHERE user_id=$1", [
        userId,
      ])
    ).rows[0];
    await bot.api.sendMessage(
      userId,
      `✅ Подписка действует до ${new Date(sub.active_until).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })} (Алматы).
Ссылки действуют 1 час. Отправьте заявку с этого Telegram-аккаунта. Обновить ссылки: /access.`,
      { reply_markup: kb },
    );
    await c.query(
      `UPDATE payments SET access_status=CASE WHEN access_status IN ('partial','granted') THEN access_status ELSE 'invited' END
      WHERE user_id=$1 AND status='approved' AND (activated_at IS NOT NULL OR legacy)
      AND access_status NOT IN ('expired','revoked')`,
      [userId],
    );
    return true;
  });
}
export async function handleJoin(
  bot: Bot,
  userId: number,
  chatId: number,
  link?: string,
) {
  if (!paidTargets().includes(chatId)) return;
  await withUserLock(userId, async (c) => {
    const invite = await c.query(
      `SELECT 1 FROM access_invites WHERE user_id=$1 AND chat_id=$2
      AND invite_link=$3 AND expires_at>clock_timestamp()`,
      [userId, chatId, link ?? ""],
    );
    if (!invite.rowCount || !(await eligible(c, userId))) {
      await bot.api.declineChatJoinRequest(chatId, userId);
      return;
    }
    await bot.api.approveChatJoinRequest(chatId, userId);
    await c.query(
      "UPDATE access_invites SET joined_at=NOW() WHERE user_id=$1 AND chat_id=$2",
      [userId, chatId],
    );
    const pending = await c.query(
      `SELECT 1 FROM unnest($2::bigint[]) AS t(chat_id)
      LEFT JOIN access_invites i ON i.chat_id=t.chat_id AND i.user_id=$1 WHERE i.joined_at IS NULL`,
      [userId, paidTargets()],
    );
    await c.query(
      `UPDATE payments SET access_status=$2 WHERE user_id=$1 AND status='approved'
      AND access_status IN ('ready','invited','partial','granted','legacy')`,
      [userId, pending.rowCount ? "partial" : "granted"],
    );
  });
}
async function removeLocked(bot: Bot, c: pg.PoolClient, userId: number) {
  if (!paidTargets().length) return false;
  let ok = true;
  for (const chatId of paidTargets()) {
    try {
      await bot.api.banChatMember(chatId, userId);
      await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
    } catch {
      ok = false;
      console.warn("Access removal failed; will retry", { chatId, userId });
    }
  }
  if (ok) {
    await c.query("DELETE FROM access_invites WHERE user_id=$1", [userId]);
    await c.query(
      "UPDATE subscriptions SET access_removed_at=NOW() WHERE user_id=$1",
      [userId],
    );
  }
  return ok;
}
export async function removeAccess(bot: Bot, userId: number) {
  return withUserLock(userId, async (c) => {
    const active = await c.query(
      "SELECT 1 FROM subscriptions WHERE user_id=$1 AND status='active' AND active_until>clock_timestamp()",
      [userId],
    );
    if (active.rowCount) return false;
    return removeLocked(bot, c, userId);
  });
}
export async function expireAccess(bot: Bot, userId: number) {
  return withUserLock(userId, async (c) => {
    const due = await c.query(
      `SELECT 1 FROM subscriptions WHERE user_id=$1
      AND ((status='active' AND active_until<=clock_timestamp()) OR (status='revoked' AND access_removed_at IS NULL))`,
      [userId],
    );
    if (!due.rowCount || !(await removeLocked(bot, c, userId))) return false;
    await c.query(
      "UPDATE subscriptions SET status='expired',updated_at=NOW() WHERE user_id=$1 AND status='active'",
      [userId],
    );
    await c.query(
      "UPDATE payments SET access_status='expired' WHERE user_id=$1 AND status='approved' AND access_status<>'revoked'",
      [userId],
    );
    return true;
  });
}
