import type { AdminReportStats } from "./db.js";

function reportDate(value: Date, timezone: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

export function formatAdminReport(
  stats: AdminReportStats,
  label: string
) {
  const conversion = stats.newUsers > 0
    ? ((stats.payingUsers / stats.newUsers) * 100).toFixed(1)
    : "0.0";

  return [
    `📊 <b>Bakieva Chat — ${label}</b>`,
    `🕒 Период: <b>${reportDate(stats.periodStart, stats.timezone)} — ${reportDate(stats.periodEnd, stats.timezone)}</b>`,
    `Часовой пояс: <b>${stats.timezone}</b>. Kaspi-платежи учитываются по времени оплаты из фискального чека.`,
    "",
    `👥 Новых клиентов: <b>${stats.newUsers}</b>`,
    `💳 Оплатили: <b>${stats.payingUsers}</b>`,
    `🧾 Успешных платежей: <b>${stats.payments}</b>`,
    `💰 Выручка: <b>${stats.revenue.toLocaleString("ru-RU")} ₸</b>`,
    `📈 Конверсия в оплату: <b>${conversion}%</b>`,
    "",
    `✅ Активных подписок сейчас: <b>${stats.activeSubscriptions}</b>`,
    `⏳ Ожидают оплаты/проверки: <b>${stats.pendingPayments}</b>`
  ].join("\n");
}
