import { UserError } from "./errors.js";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { pool, stats, setSetting } from "./db.js";
import {
  assignLegacyPlan,
  getPlans,
  grantSubscription,
  revokeSubscription,
  updatePlan,
} from "./commerce.js";
import { removeAccess, sendAccess } from "./access.js";
import {
  adminPrivate,
  continuePurchase,
  notifyPayment,
} from "./purchase-handlers.js";
import {
  buyerRegistry,
  chunks,
  contactsExport,
  localDay,
  resolveReportPart,
  salesCsv,
  sendSales,
  shiftDay,
  validPeriod,
} from "./sales.js";

export async function adminPanel(ctx: Context) {
  if (!adminPrivate(ctx)) return;
  await pool.query("DELETE FROM admin_flows WHERE admin_id=$1", [ctx.from!.id]);
  const s = await stats();
  await ctx.reply(
    `Админ-панель Bakieva Chat
Пользователей: ${s.users}; активных подписок: ${s.active}
Ожидают проверки: ${s.pending}; подтверждённая выручка: ${s.revenue.toLocaleString("ru-RU")} ₸
/grant ID DAYS · /extend ID DAYS · /revoke ID
/price 5000 · /plan month|half_year PRICE [DAYS]
/sales_report YYYY-MM-DD YYYY-MM-DD · /sales_export
/sales_delivery — ошибки ежедневных отчётов
/news · /members · /set · /broadcast
/admin_cancel — отменить ввод`,
    {
      reply_markup: new InlineKeyboard()
        .text("Продажи сегодня", "admin:today")
        .row()
        .text("Все покупатели", "admin:buyers:0")
        .row()
        .text("Выгрузить контакты", "admin:contacts")
        .row()
        .text("Активные подписки", "admin:active:0")
        .row()
        .text("Ожидают подтверждения оплаты", "admin:pending:0")
        .row()
        .text("Оплатили без WhatsApp", "admin:missing:0")
        .row()
        .text("Изменить тарифы", "admin:plans")
        .row()
        .text("Отправить отчёт", "admin:report")
        .row()
        .text("Продлить подписку", "admin:extend")
        .row()
        .text("Отключить доступ", "admin:revoke")
        .row()
        .text("📰 Опубликовать новость", "news:start")
        .row()
        .text("Отчёт новостей", "news:report")
        .row()
        .text("Учёт участников", "members:report"),
    },
  );
}
async function list(ctx: Context, type: string, page: number) {
  if (!adminPrivate(ctx)) return;
  const conditions: Record<string, string> = {
    buyers: "p.status='approved'",
    pending: "p.status='pending' AND p.claimed_at IS NOT NULL",
    missing: "p.status='approved' AND u.whatsapp IS NULL",
    active:
      "p.status='approved' AND s.status='active' AND s.active_until>NOW()",
  };
  const condition = conditions[type];
  if (!condition) return;
  const source =
    type === "pending"
      ? "payments"
      : `(SELECT DISTINCT ON (user_id) * FROM payments
    WHERE status='approved' AND user_id IS NOT NULL ORDER BY user_id,id DESC)`;
  const rows = (
    await pool.query(
      `SELECT p.*,u.whatsapp AS current_phone,s.active_until,
    (SELECT COUNT(*) FROM payments history WHERE history.user_id=p.user_id AND history.status='approved') AS purchase_count
    FROM ${source} p LEFT JOIN users u ON u.telegram_id=p.user_id LEFT JOIN subscriptions s ON s.user_id=p.user_id
    WHERE ${condition} ORDER BY p.id DESC LIMIT 11 OFFSET $1`,
      [page * 10],
    )
  ).rows;
  if (!rows.length) {
    await ctx.reply("Записей нет.");
    return;
  }
  for (const part of chunks(
    rows
      .slice(0, 10)
      .map(
        (
          p,
        ) => `#${p.id} ${p.buyer_name ?? "обезличено"} (${p.user_id ?? "ID удалён"})
${p.plan_name}: ${p.amount} ₸; платёж: ${p.status}; доступ: ${p.access_status}; подтверждённых покупок: ${p.purchase_count}
WhatsApp: ${p.current_phone ?? "не предоставлен"}; подписка до: ${p.active_until ? new Date(p.active_until).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" }) : "не активирована"}`,
      )
      .join("\n\n"),
  ))
    await ctx.reply(part);
  const kb = new InlineKeyboard();
  if (type === "pending")
    for (const p of rows.slice(0, 10))
      kb.text(`Проверить #${p.id}`, `admin:payment:${p.id}`).row();
  if (type === "missing")
    for (const p of rows.slice(0, 10))
      kb.text(
        `Напомнить WhatsApp: ${p.user_id}`,
        `admin:remind:${p.user_id}`,
      ).row();
  if (page > 0) kb.text("← Назад", `admin:${type}:${page - 1}`);
  if (rows.length > 10) kb.text("Далее →", `admin:${type}:${page + 1}`);
  kb.row().text("Экспорт реестра", "admin:export");
  await ctx.reply(
    type === "pending"
      ? "Заявки на проверку: одна строка на заявку."
      : "Одна строка на покупателя, показана последняя покупка. Полная история покупок доступна в экспорте.",
    { reply_markup: kb },
  );
}
async function prompt(ctx: Context, action: string, text: string) {
  await pool.query(
    `INSERT INTO admin_flows(admin_id,action) VALUES($1,$2) ON CONFLICT(admin_id)
    DO UPDATE SET action=EXCLUDED.action,expires_at=NOW()+interval '10 minutes'`,
    [ctx.from!.id, action],
  );
  await ctx.reply(text + "\nОтмена: /admin_cancel.");
}
async function manage(ctx: Context, action: string, body: string) {
  const args = body.trim().split(/\s+/);
  if (action === "report") {
    if (!validPeriod(args[0] ?? "", args[1] ?? ""))
      throw new UserError("Введите две даты: YYYY-MM-DD YYYY-MM-DD");
    await sendSales({ api: ctx.api } as Bot, ctx.from!.id, args[0], args[1]);
  } else if (action.startsWith("plan:")) {
    await updatePlan(
      action.slice(5),
      Number(args[0]),
      args[1] ? Number(args[1]) : undefined,
    );
    await ctx.reply(
      "Тариф обновлён. Уже созданные покупки сохраняют прежнюю цену и срок.",
    );
  } else if (action === "extend") {
    const [id, days] = args.map(Number);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new UserError("Формат: TELEGRAM_ID DAYS");
    const until = await grantSubscription(
      id,
      days,
      ctx.from!.id,
      ctx.update.update_id,
    );
    const sent = await sendAccess({ api: ctx.api } as Bot, id);
    await ctx.reply(
      `Продлено до ${until.toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })}. ${sent ? "Приглашения отправлены." : "Проверьте условия доступа."}`,
    );
  } else if (action === "revoke") {
    const id = Number(args[0]);
    if (!Number.isSafeInteger(id) || id <= 0)
      throw new UserError("Формат: TELEGRAM_ID");
    await revokeSubscription(id);
    const removed = await removeAccess({ api: ctx.api } as Bot, id);
    await ctx.reply(
      removed
        ? `Доступ ${id} отозван.`
        : "Подписка отозвана. Удаление из Telegram не завершено; планировщик повторит попытку.",
    );
  }
}
export function installAdminHandlers(bot: Bot) {
  bot.command("admin", adminPanel);
  bot.command("admin_cancel", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    await pool.query("DELETE FROM admin_flows WHERE admin_id=$1", [
      ctx.from!.id,
    ]);
    await ctx.reply("Ввод отменён.");
  });
  bot.callbackQuery(/^admin:(.+)$/, async (ctx) => {
    if (!adminPrivate(ctx)) {
      await ctx.answerCallbackQuery({ text: "Нет доступа", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const action = ctx.match[1];
    const match = /^(buyers|active|pending|missing):(\d+)$/.exec(action);
    if (match) {
      await list(ctx, match[1], Number(match[2]));
      return;
    }
    if (action === "today")
      await sendSales(bot, ctx.from!.id, localDay(), localDay());
    else if (action === "export")
      await ctx.replyWithDocument(
        new InputFile(salesCsv(await buyerRegistry()), "buyers.csv"),
      );
    else if (action === "contacts")
      await ctx.reply(
        "Контакты покупателей и добровольная маркетинговая аудитория:",
        {
          reply_markup: new InlineKeyboard()
            .text("Все контакты", "admin:contacts_all")
            .row()
            .text(
              "Только согласившиеся на маркетинг",
              "admin:contacts_marketing",
            ),
        },
      );
    else if (action.startsWith("contacts_"))
      await ctx.replyWithDocument(
        new InputFile(
          await contactsExport(action === "contacts_marketing"),
          action === "contacts_marketing"
            ? "marketing-opt-in.csv"
            : "contacts.csv",
        ),
      );
    else if (action === "plans") {
      const kb = new InlineKeyboard();
      for (const p of await getPlans())
        kb.text(
          `${p.name}: ${p.price} ₸ / ${p.days} дней`,
          `admin:plan:${p.id}`,
        ).row();
      await ctx.reply("Выберите тариф для изменения:", { reply_markup: kb });
    } else if (action.startsWith("plan:"))
      await prompt(
        ctx,
        action,
        "Введите новую цену и, при необходимости, срок в днях: PRICE [DAYS]",
      );
    else if (action === "report")
      await prompt(
        ctx,
        "report",
        "Введите период отчёта: YYYY-MM-DD YYYY-MM-DD",
      );
    else if (action === "extend")
      await prompt(
        ctx,
        "extend",
        "Введите Telegram ID и дни продления: TELEGRAM_ID DAYS",
      );
    else if (action === "revoke")
      await prompt(ctx, "revoke", "Введите Telegram ID для отключения доступа");
    else if (action.startsWith("remind:")) {
      await continuePurchase(bot, Number(action.slice(7)));
      await ctx.reply("Клиенту отправлен следующий шаг оформления.");
    } else if (action.startsWith("payment:")) {
      const p = (
        await pool.query(
          "SELECT * FROM payments WHERE id=$1 AND status='pending'",
          [action.slice(8)],
        )
      ).rows[0];
      if (p) await notifyPayment(bot, p);
    }
  });
  bot.command(["sales_today", "sales_yesterday"], async (ctx) => {
    if (!adminPrivate(ctx)) return;
    const day = ctx.message!.text.startsWith("/sales_yesterday")
      ? shiftDay(localDay(), -1)
      : localDay();
    await sendSales(bot, ctx.from!.id, day, day);
  });
  bot.command("sales_report", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    const args = ctx.match.trim();
    if (!args) {
      await prompt(ctx, "report", "Введите период: YYYY-MM-DD YYYY-MM-DD");
      return;
    }
    await manage(ctx, "report", args);
  });
  bot.command("sales_export", async (ctx) => {
    if (adminPrivate(ctx))
      await ctx.replyWithDocument(
        new InputFile(salesCsv(await buyerRegistry()), "buyers.csv"),
      );
  });
  bot.command(["contacts_export", "contacts_marketing"], async (ctx) => {
    if (adminPrivate(ctx))
      await ctx.replyWithDocument(
        new InputFile(
          await contactsExport(
            ctx.message!.text.startsWith("/contacts_marketing"),
          ),
          "whatsapp-contacts.csv",
        ),
      );
  });
  bot.command("plan", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    const [id, price, days] = ctx.match.trim().split(/\s+/);
    await updatePlan(id, Number(price), days ? Number(days) : undefined);
    await ctx.reply("Тариф обновлён.");
  });
  bot.command("price", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    await updatePlan("month", Number(ctx.match.trim()));
    await ctx.reply("Цена тарифа «1 месяц» обновлена.");
  });
  bot.command("report_time", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    const time = ctx.match.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
      throw new UserError("Формат: /report_time HH:MM (Алматы)");
    await setSetting("sales_report_time", time);
    await ctx.reply(`Ежедневный отчёт за вчера: ${time} (Алматы).`);
  });
  bot.command("payment_plan", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    const [id, plan] = ctx.match.trim().split(/\s+/);
    await assignLegacyPlan(Number(id), plan);
    await ctx.reply(
      "Архивной заявке назначен тариф. Историческая сумма сохранена. Проверьте реальное поступление перед подтверждением.",
    );
  });
  bot.command(["grant", "extend"], async (ctx) => {
    if (adminPrivate(ctx)) await manage(ctx, "extend", ctx.match);
  });
  bot.command("revoke", async (ctx) => {
    if (adminPrivate(ctx)) await manage(ctx, "revoke", ctx.match);
  });
  bot.command("sales_delivery", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    const r =
      await pool.query(`SELECT d.id,d.admin_id,to_char(d.report_date,'YYYY-MM-DD') AS report_date,p.part,p.status FROM report_deliveries d
      JOIN report_parts p ON p.delivery_id=d.id WHERE d.status<>'sent' ORDER BY d.id,p.part LIMIT 100`);
    for (const part of chunks(
      r.rows
        .map(
          (p) =>
            `Отчёт #${p.id}; получатель ${p.admin_id}; ${p.report_date}; часть ${p.part}: ${p.status}`,
        )
        .join("\n") || "Нет незавершённых отчётов.",
    ))
      await ctx.reply(part);
    await ctx.reply(
      "При неопределённом результате проверьте диалог получателя. /sales_resolve ID PART sent — отметить доставленной; retry — явно разрешить повтор (возможен дубликат).",
    );
  });
  bot.command("sales_resolve", async (ctx) => {
    if (!adminPrivate(ctx)) return;
    const [id, part, decision] = ctx.match.trim().split(/\s+/);
    if (
      !/^\d+$/.test(id) ||
      !/^\d+$/.test(part) ||
      !["sent", "retry"].includes(decision)
    )
      throw new UserError("Формат: /sales_resolve ID PART sent|retry");
    const changed = await resolveReportPart(
      ctx.from!.id,
      Number(id),
      Number(part),
      decision as "sent" | "retry",
    );
    await ctx.reply(
      changed
        ? "Решение сохранено; планировщик продолжит доставку."
        : "Неопределённая часть не найдена.",
    );
  });
  bot.on("message:text", async (ctx, next) => {
    if (!adminPrivate(ctx) || ctx.message!.text.startsWith("/")) return next();
    const flow = (
      await pool.query(
        "SELECT action FROM admin_flows WHERE admin_id=$1 AND expires_at>NOW()",
        [ctx.from!.id],
      )
    ).rows[0];
    if (!flow) return next();
    await manage(ctx, flow.action, ctx.message!.text);
    await pool.query("DELETE FROM admin_flows WHERE admin_id=$1", [
      ctx.from!.id,
    ]);
  });
}
