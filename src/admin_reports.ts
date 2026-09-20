import type { AdminReportStats } from "./db.js";

export function formatAdminReport(
  stats: AdminReportStats,
  label: string
) {
  const conversion = stats.newUsers > 0
    ? ((stats.payingUsers / stats.newUsers) * 100).toFixed(1)
    : "0.0";

  return [
    `📊 <b>Bakieva Chat — ${label}</b>`,
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
