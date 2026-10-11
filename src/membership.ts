import { Bot, InputFile, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { config } from "./config.js";
import { allMembers, latestMembers, membershipStats, previouslyKnownUsers, saveMemberEvent, saveMemberSnapshot } from "./member-db.js";
import { newsTargets } from "./news.js";
import { syncLegacyMembers } from "./mtproto-sync.js";

export function membershipTargets(): number[] {
  return newsTargets();
}

function isAdminPrivate(ctx: Context): boolean {
  return ctx.chat?.type === "private" && ctx.from !== undefined && config.adminIds.has(ctx.from.id);
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, 100);
}

function localDate(d: Date): string {
  return d.toLocaleString("ru-RU", { timeZone: "Asia/Almaty", hour12: false });
}

function active(status: { status: string; is_member?: boolean }): boolean {
  return status.status === "member" ||
    status.status === "administrator" ||
    status.status === "creator" ||
    (status.status === "restricted" && status.is_member === true);
}

async function memberChange(bot: Bot, ctx: Context, action: "joined" | "left",
                            chatId: number, user: {
                              id: number; username?: string; first_name?: string; last_name?: string
                            }, occurredAt: Date, source: "chat_member" | "service_message") {
  if (!membershipTargets().includes(chatId)) return;
  const changed = await saveMemberEvent({
    chatId, userId: user.id, username: user.username,
    firstName: user.first_name, lastName: user.last_name
  }, action, occurredAt, source);
  if (!changed || action !== "joined") return;

  let chatTitle = String(chatId);
  try {
    const chat = await bot.api.getChat(chatId);
    if ("title" in chat && chat.title) chatTitle = clean(chat.title);
  } catch {
    // The identifier remains useful even if getChat temporarily fails.
  }
  const who = clean([user.first_name, user.last_name].filter(Boolean).join(" ")) || "Без имени";
  const message = [
    "👥 Новый участник Bakieva Chat",
    `Пользователь: ${who}`,
    `Username: ${user.username ? "@" + clean(user.username) : "нет"}`,
    `Telegram ID: ${user.id}`,
    `Группа / канал: ${chatTitle} (${chatId})`,
    `Вступил: ${localDate(occurredAt)} (Алматы)`
  ].join("\n");
  await Promise.all([...config.adminIds].map(async id => {
    try { await bot.api.sendMessage(id, message); }
    catch (err) { console.warn("Member notification failed", { adminId: id, err }); }
  }));
}

async function memberReport(ctx: Context) {
  if (!isAdminPrivate(ctx)) return;
  const targets = membershipTargets();
  if (!targets.length) {
    await ctx.reply("Не настроены ID групп и каналов (PAID_CHAT_ID, PAID_CHANNEL_ID, NEWS_TARGET_CHAT_IDS).");
    return;
  }
  const rows = await membershipStats(targets);
  const lines = ["👥 Учёт участников Bakieva Chat", ""];
  for (const id of targets) {
    const s = rows.find(row => row.chatId === id);
    let name = String(id);
    let total: number | null = null;
    try {
      const chat = await ctx.api.getChat(id);
      if ("title" in chat && chat.title) name = clean(chat.title);
      total = await ctx.api.getChatMemberCount(id);
    } catch { /* May be inaccessible; show known data only. */ }
    lines.push(`${name} (${id})`);
    lines.push(`В базе сейчас: ${s?.current ?? 0}${total === null ? "" : ` / в Telegram: ${total}`}`);
    lines.push(`С датой вступления: ${s?.dated ?? 0}; за 24 ч: ${s?.lastDay ?? 0}; вышли: ${s?.left ?? 0}`);
    lines.push("");
  }
  lines.push("Число в базе может быть меньше реального состава, пока историческая синхронизация не завершена.");
  lines.push("Даты, которых Telegram не сообщил, обозначаются как «неизвестно».");
  lines.push("/members_list — последние участники");
  lines.push("/members_export — полный CSV из базы");
  lines.push("/members_sync — попробовать получить прежних участников через Telegram API");
  await ctx.reply(lines.join("\n"), {
    reply_markup: new InlineKeyboard()
      .text("👤 Последние участники", "members:list")
      .row().text("🔄 Синхронизировать прежних", "members:sync")
      .row().text("📄 Экспорт CSV", "members:export")
  });
}

async function memberList(ctx: Context) {
  if (!isAdminPrivate(ctx)) return;
  const rows = await latestMembers(membershipTargets());
  if (!rows.length) {
    await ctx.reply("Записей пока нет. Новые вступления появятся автоматически; для старых есть /members_sync.");
    return;
  }
  const lines = ["👥 Последние известные участники", ""];
  for (const m of rows) {
    const name = clean([m.first_name, m.last_name].filter(Boolean).join(" ")) || "Без имени";
    const date = m.joined_at ? localDate(new Date(m.joined_at)) : "неизвестно";
    lines.push(`${m.is_member ? "✅" : "🚪"} ${name} ${m.username ? "@" + clean(m.username) : ""} (ID ${m.user_id})`);
    lines.push(`Чат ${m.chat_id} · вступил: ${date}${m.join_source === "mtproto" ? " (история Telegram)" : ""}`);
  }
  const chunks: string[] = [];
  let chunk = "";
  for (const line of lines) {
    if (chunk.length + line.length > 3600) { chunks.push(chunk); chunk = ""; }
    chunk += line + "\n";
  }
  if (chunk) chunks.push(chunk);
  for (const part of chunks) await ctx.reply(part);
}

function csvCell(value: unknown): string {
  let s = String(value ?? "");
  // Prevent formula execution in spreadsheet software when admins open the export.
  if (/^[=+@\-]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

async function memberExport(ctx: Context) {
  if (!isAdminPrivate(ctx)) return;
  const rows = await allMembers(membershipTargets());
  const header = ["chat_id","user_id","username","first_name","last_name","in_chat","join_date","date_source","first_seen","left_at"];
  const csv = [header.map(csvCell).join(","), ...rows.map(m => [
    m.chat_id, m.user_id, m.username, m.first_name, m.last_name,
    m.is_member, m.joined_at ? new Date(m.joined_at).toISOString() : "",
    m.join_source, new Date(m.first_seen_at).toISOString(),
    m.left_at ? new Date(m.left_at).toISOString() : ""
  ].map(csvCell).join(","))].join("\r\n");
  await ctx.replyWithDocument(
    new InputFile(Buffer.from("\uFEFF" + csv, "utf8"), "bakieva-members.csv"),
    { caption: `Экспорт записей: ${rows.length}. Пустая дата вступления означает, что Telegram её не предоставил.` }
  );
}

const activeSyncs = new Set<number>();
async function memberSync(ctx: Context) {
  if (!isAdminPrivate(ctx)) return;
  if (activeSyncs.size) {
    await ctx.reply("Синхронизация уже выполняется. Повторный запуск заблокирован.");
    return;
  }
  const hasMtproto = Boolean(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH);
  const targets = membershipTargets();
  activeSyncs.add(ctx.from!.id);
  await ctx.reply(`🔄 Проверяю старых участников ${targets.length} чатов. Сначала сверю тех, кто уже известен боту. Telegram может вернуть неполный список.`);
  // Do not await the potentially long API scan in the grammY long-polling update handler.
  // Other updates (including payments) must continue processing.
  void (async () => {
  try {
    const known = await previouslyKnownUsers(2000);
    for (const chatId of targets) {
      let confirmed = 0, unavailable = 0;
      for (const user of known) {
        try {
          const member = await ctx.api.getChatMember(chatId, user.userId);
          if (active(member)) {
            await saveMemberSnapshot({
              chatId, userId: user.userId,
              username: member.user.username ?? user.username,
              firstName: member.user.first_name ?? user.firstName,
              lastName: member.user.last_name ?? null
            });
            confirmed++;
          }
        } catch { unavailable++; }
        // Throttle scans to avoid overwhelming the Bot API.
        await new Promise(resolve => setTimeout(resolve, 65));
      }
      await ctx.reply(`Из ранее известных боту: чат ${chatId} — подтверждено ${confirmed} участников; не удалось проверить ${unavailable}. Это не полный исторический список.`);
    }
    if (hasMtproto) {
      const results = await syncLegacyMembers(targets);
      for (const item of results) {
        await ctx.reply(`${item.error ? "⚠️" : "✅"} MTProto, чат ${item.chatId}: найдено ${item.found}; сохранено ${item.saved}; ${item.error ? clean(item.error) : item.partial ? "список может быть неполным" : "синхронизация выполнена"}.`);
      }
    } else {
      await ctx.reply("Для попытки более полной синхронизации прежних участников добавьте TELEGRAM_API_ID и TELEGRAM_API_HASH в Railway, затем повторите /members_sync.");
    }
  } catch (err) {
    console.error("Legacy member sync failed", err);
    await ctx.reply("Синхронизация не завершена. Проверьте Railway logs и права Telegram API. Уже сохранённые записи остаются в базе.");
  } finally {
    activeSyncs.delete(ctx.from!.id);
  }
  })().catch(error => console.error("Unexpected membership sync failure", error));
}

export function installMembershipHandlers(bot: Bot) {
  bot.on("chat_member", async ctx => {
    const update = ctx.chatMember;
    const was = active(update.old_chat_member);
    const now = active(update.new_chat_member);
    if (was === now) return;
    await memberChange(
      bot, ctx, now ? "joined" : "left", update.chat.id,
      update.new_chat_member.user, new Date(update.date * 1000), "chat_member"
    );
  });

  // Fallback for service messages if a chat_member update was not delivered.
  bot.on("message:new_chat_members", async ctx => {
    for (const user of ctx.message.new_chat_members) {
      await memberChange(bot, ctx, "joined", ctx.chat.id, user,
        new Date(ctx.message.date * 1000), "service_message");
    }
  });

  bot.command("members", memberReport);
  bot.command("members_list", memberList);
  bot.command("members_export", memberExport);
  bot.command("members_sync", memberSync);
  bot.callbackQuery("members:report", async ctx => {
    if (!isAdminPrivate(ctx)) return;
    await ctx.answerCallbackQuery();
    await memberReport(ctx);
  });
  bot.callbackQuery("members:list", async ctx => {
    if (!isAdminPrivate(ctx)) return;
    await ctx.answerCallbackQuery();
    await memberList(ctx);
  });
  bot.callbackQuery("members:export", async ctx => {
    if (!isAdminPrivate(ctx)) return;
    await ctx.answerCallbackQuery();
    await memberExport(ctx);
  });
  bot.callbackQuery("members:sync", async ctx => {
    if (!isAdminPrivate(ctx)) return;
    await ctx.answerCallbackQuery();
    await memberSync(ctx);
  });
}
