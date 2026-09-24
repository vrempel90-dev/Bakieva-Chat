import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { pool, getPaidChannelId, getPaidMainChatId, getUserLanguage, isSubscriptionActive } from "./db.js";
import { c, localeFor } from "./i18n.js";

export type AccessStatus = "access_pending" | "access_partial" | "access_failed" |
  "access_delivered" | "access_configuration_error" | "access_telegram_error";

function activeMember(member: { status: string; is_member?: boolean }) {
  return member.status === "administrator" || member.status === "creator" ||
    member.status === "member" || (member.status === "restricted" && member.is_member === true);
}

function transient(error: unknown) {
  const value = error as { error_code?: number; message?: string; description?: string };
  const code = value.error_code;
  return code === 429 || (typeof code === "number" && code >= 500) ||
    (code === undefined && /fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN/i.test(value.message ?? ""));
}

function safeError(error: unknown) {
  const value = error as { error_code?: number; name?: string };
  return { code: value?.error_code ?? null, type: value?.name ?? "Error" };
}

export async function retryTelegram<T>(action: () => Promise<T>, wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt >= 2 || !transient(error)) throw error;
      const retryAfter = Number((error as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 0);
      await wait(Math.min(10_000, Math.max(250 * 2 ** attempt, retryAfter * 1000)));
    }
  }
}

export async function checkAccessTargets(bot: Bot) {
  const [channelId, mainChatId] = await Promise.all([getPaidChannelId(), getPaidMainChatId()]);
  if (!channelId || !mainChatId || channelId === mainChatId) throw new Error("Paid access targets are not configured distinctly");
  const me = await retryTelegram(() => bot.api.getMe());
  const [channel, mainChat] = await Promise.all([
    retryTelegram(() => bot.api.getChat(channelId)), retryTelegram(() => bot.api.getChat(mainChatId))
  ]);
  if (channel.type !== "channel" || !["group", "supergroup"].includes(mainChat.type)) {
    throw new Error("Paid access target types are invalid");
  }
  const [channelBot, mainChatBot] = await Promise.all([
    retryTelegram(() => bot.api.getChatMember(channelId, me.id)),
    retryTelegram(() => bot.api.getChatMember(mainChatId, me.id))
  ]);
  for (const member of [channelBot, mainChatBot]) {
    if (member.status !== "administrator" && member.status !== "creator") throw new Error("Bot is not an administrator of a paid target");
    if (member.status === "administrator" && !member.can_invite_users) throw new Error("Bot cannot create invites for a paid target");
  }
  console.info(JSON.stringify({ event: "channel_validated" }));
  console.info(JSON.stringify({ event: "main_chat_validated" }));
  return { channelId, mainChatId };
}

export async function sendAccess(bot: Bot, userId: number, activeUntil: Date) {
  const client = await pool.connect();
  // Session lock serializes Telegram side effects for the same user across instances.
  let locked = false;
  let channelReady = false;
  let mainChatReady = false;
  try {
    await client.query("SELECT pg_advisory_lock($1,$2)", [834273, userId]);
    locked = true;
    const lang = await getUserLanguage(userId);
    const ui = c(lang);
    await client.query(`INSERT INTO access_deliveries(user_id,subscription_until)
      VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET
      subscription_until=EXCLUDED.subscription_until, updated_at=NOW()`, [userId, activeUntil]);
    const record = (await client.query("SELECT * FROM access_deliveries WHERE user_id=$1", [userId])).rows[0];
    const { channelId, mainChatId } = await checkAccessTargets(bot);
    const expireDate = Math.floor(Date.now() / 1000) + 3600;
    const targets = [
      { id: channelId, invite: "channel_invite", expires: "channel_invite_expires_at", ready: "channel_ready" },
      { id: mainChatId, invite: "main_chat_invite", expires: "main_chat_invite_expires_at", ready: "main_chat_ready" }
    ] as const;
    const urls: Array<string | null> = [];
    for (const target of targets) {
      const member = await retryTelegram(async () => {
        try { return await bot.api.getChatMember(target.id, userId); }
        catch (error) {
          const telegram = error as { error_code?: number; description?: string };
          if (telegram.error_code === 400 &&
              /user not found|user[_ ]not[_ ]participant|participant_id_invalid/i.test(telegram.description ?? "")) {
            return { status: "left" as const };
          }
          throw error;
        }
      });
      if (activeMember(member)) {
        urls.push(null);
      } else if (record[target.invite] && new Date(record[target.expires]).getTime() > Date.now() + 300_000) {
        urls.push(record[target.invite]);
      } else {
        const link = await retryTelegram(() => bot.api.createChatInviteLink(target.id, {
          expire_date: expireDate, creates_join_request: true, name: `Bakieva ${userId}`
        }));
        urls.push(link.invite_link);
        console.info(JSON.stringify({ event: target.id === channelId ? "channel_invite_created" : "main_chat_invite_created", userId }));
        await client.query(`UPDATE access_deliveries SET ${target.invite}=$2, ${target.expires}=to_timestamp($3),
          ${target.ready}=TRUE, updated_at=NOW() WHERE user_id=$1`, [userId, link.invite_link, expireDate]);
      }
      if (target.id === channelId) channelReady = true;
      else mainChatReady = true;
    }
    const keyboard = new InlineKeyboard();
    if (urls[0]) keyboard.url(ui.joinChannelButton, urls[0]);
    if (urls[1]) keyboard.row().url(ui.joinChatButton, urls[1]);
    await retryTelegram(() => bot.api.sendMessage(userId,
      ui.accessGranted(activeUntil.toLocaleDateString(localeFor(lang))) +
        (urls.every(url => !url) ? (lang === "ru" ? "\nВы уже состоите в канале и чате." : "\nСіз арна мен чатқа қосылғансыз.") : ""),
      urls.some(Boolean) ? { reply_markup: keyboard } : {}));
    await client.query(`UPDATE access_deliveries SET status='access_delivered',
      channel_ready=TRUE, main_chat_ready=TRUE, attempts=0, delivered_at=NOW(), updated_at=NOW()
      WHERE user_id=$1`, [userId]);
    console.info(JSON.stringify({ event: "access_delivered", userId }));
  } catch (error) {
    const state: AccessStatus = channelReady || mainChatReady ? "access_partial" :
      /not configured|target types|not an administrator|cannot create invites/i.test(String(error)) ?
        "access_configuration_error" : "access_telegram_error";
    // A database outage can also prevent recording the failed attempt; keep the original error.
    try {
      await client.query(`UPDATE access_deliveries SET status=$2, retryable=$3, attempts=attempts+1,
        next_retry_at=NOW() + (LEAST(3600, 30 * power(2, LEAST(attempts,7))) * interval '1 second'),
        updated_at=NOW() WHERE user_id=$1`, [userId, state, transient(error)]);
    } catch (dbError) { console.error("access_status_write_failed", { userId, error: safeError(dbError) }); }
    console.error(JSON.stringify({ event: "access_failed", userId, state, error: safeError(error) }));
    throw error;
  } finally {
    try { if (locked) await client.query("SELECT pg_advisory_unlock($1,$2)", [834273, userId]); }
    finally { client.release(); }
  }
}

export async function removeAccess(bot: Bot, userId: number) {
  // Never revoke an account that renewed while the expiry job was running.
  if (await isSubscriptionActive(userId)) return;
  const [channelId, mainChatId] = await Promise.all([getPaidChannelId(), getPaidMainChatId()]);
  for (const chatId of [channelId, mainChatId].filter(Boolean)) {
    try {
      await retryTelegram(() => bot.api.banChatMember(chatId, userId));
      await retryTelegram(() => bot.api.unbanChatMember(chatId, userId, { only_if_banned: true }));
    } catch (error) {
      console.error("access_revoke_failed", { chatId, userId, error: safeError(error) });
      throw error;
    }
  }
}
