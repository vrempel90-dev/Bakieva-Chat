import type { ContentUserDelivery } from "./db.js";

export type RecipientStatusFilter = "all" | "sent" | "failed";

export function formatRecipientDeliveryPage(args: {
  postId: number;
  sent: number;
  failed: number;
  attempted: number;
  total: number;
  filter: RecipientStatusFilter;
  page: number;
  pageSize: number;
  entries: ContentUserDelivery[];
}): string {
  const { postId, sent, failed, attempted, total, filter, page, pageSize, entries } = args;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const lines = [
    `📬 Личные сообщения по публикации #${postId}`,
    `✅ Принято Telegram: ${sent} | ❌ Ошибки: ${failed}`,
    `Зафиксировано попыток: ${attempted}`,
    "",
    `Список: ${filter === "sent" ? "успешные" : filter === "failed" ? "ошибки" : "все"} · страница ${page + 1}/${pages}`,
    ""
  ];
  if (!entries.length) {
    lines.push("Записей нет. У старых публикаций персональный журнал мог не сохраняться.");
  }
  for (const entry of entries) {
    const label = [entry.firstName?.replace(/[\r\n]/g, " ").slice(0, 60),
      entry.username ? `@${entry.username.replace(/^@/, "").replace(/[\r\n]/g, "").slice(0, 40)}` : null]
      .filter(Boolean).join(" ") || "Пользователь";
    lines.push(`${entry.status === "sent" ? "✅" : "❌"} ${label} · ID ${entry.userId}`);
    if (entry.messageId !== null) lines.push(`Сообщение #${entry.messageId}`);
    if (entry.error) lines.push(`Причина: ${entry.error.replace(/[\r\n]/g, " ").slice(0, 160)}`);
    lines.push("");
  }
  lines.push("Статус «✅» означает, что Telegram принял сообщение, а не что получатель его прочитал.");
  return lines.join("\n");
}
