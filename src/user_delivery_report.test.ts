import { describe, expect, it } from "vitest";
import { formatRecipientDeliveryPage } from "./user_delivery_report.js";

const args = {
  postId: 55,
  sent: 2,
  failed: 1,
  attempted: 3,
  total: 3,
  filter: "all" as const,
  page: 0,
  pageSize: 8,
  entries: [
    {
      userId: 123456789,
      firstName: "Ирина",
      username: "irina",
      status: "sent" as const,
      messageId: 215,
      error: null,
      attemptedAt: new Date("2026-10-10T12:00:00Z")
    },
    {
      userId: 987654321,
      firstName: null,
      username: null,
      status: "failed" as const,
      messageId: null,
      error: "Telegram 403: blocked by user",
      attemptedAt: new Date("2026-10-10T12:00:00Z")
    }
  ]
};

describe("admin Telegram recipient report", () => {
  it("shows identifiable recipients with Telegram acceptance and errors", () => {
    const text = formatRecipientDeliveryPage(args);
    expect(text).toContain("Ирина @irina · ID 123456789");
    expect(text).toContain("Сообщение #215");
    expect(text).toContain("ID 987654321");
    expect(text).toContain("blocked by user");
    expect(text).toContain("✅ Принято Telegram: 2 | ❌ Ошибки: 1");
    expect(text).toContain("а не что получатель его прочитал");
  });

  it("has useful empty states and correct page descriptions", () => {
    const text = formatRecipientDeliveryPage({
      ...args, filter: "failed", page: 1, total: 12, entries: []
    });
    expect(text).toContain("ошибки · страница 2/2");
    expect(text).toContain("Записей нет");
  });
});
