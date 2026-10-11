import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildMembersXlsx, telegramProfileLink } from "./members_excel.js";

describe("Excel member export", () => {
  it("links a valid username and falls back to a Telegram ID link", () => {
    expect(telegramProfileLink("123456789", "member_test")).toBe("https://t.me/member_test");
    expect(telegramProfileLink("123456789", null)).toBe("tg://user?id=123456789");
    expect(telegramProfileLink("123456789", "../bad-path")).toBe("tg://user?id=123456789");
    expect(telegramProfileLink("not-an-id", null)).toBeNull();
  });

  it("exports two readable Russian sheets, hyperlinks, status and true date semantics", async () => {
    const payload = await buildMembersXlsx([
      {
        chat_id: "-1001234567890",
        user_id: "123456789012345",
        username: "member_test",
        first_name: "Александр",
        last_name: "Иванов",
        is_member: true,
        joined_at: "2026-10-11T12:30:00Z",
        join_source: "chat_member",
        first_seen_at: "2026-10-11T12:30:00Z",
        left_at: null
      },
      {
        chat_id: "-1001234567890",
        user_id: "9876543210",
        username: null,
        first_name: "Айжан",
        last_name: null,
        is_member: false,
        joined_at: null,
        join_source: "unknown",
        first_seen_at: "2026-10-01T09:00:00Z",
        left_at: "2026-10-10T09:00:00Z"
      }
    ], [{ id: -1001234567890, title: "Закрытый чат", telegramCount: 54 }],
       new Date("2026-10-11T13:00:00Z"));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(payload as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    expect(workbook.worksheets.map(w => w.name)).toEqual(["Сводка", "Участники"]);
    const summary = workbook.getWorksheet("Сводка")!;
    const people = workbook.getWorksheet("Участники")!;

    expect(summary.getCell("A8").value).toBe("Закрытый чат");
    expect(summary.getCell("C8").value).toBe(2);
    expect(summary.getCell("D8").value).toBe(1);
    expect(summary.getCell("H8").value).toBe(54);
    expect(people.getCell("C7").hyperlink).toBe("https://t.me/member_test");
    expect(people.getCell("K7").hyperlink).toBe("https://t.me/member_test");
    expect(people.getCell("K8").hyperlink).toBe("tg://user?id=9876543210");
    expect(people.getCell("E7").value).toBe("123456789012345");
    expect(people.getCell("F7").value).toBe("В чате");
    expect(people.getCell("G8").value).toBe("Неизвестно");
    expect(people.getCell("F8").value).toBe("Вышел");

    const joinedAt = people.getCell("G7").value;
    expect(joinedAt).toBeInstanceOf(Date);
    // 12:30 UTC -> 17:30 Asia/Almaty in October 2026.
    expect((joinedAt as Date).getUTCHours()).toBe(17);
    expect((joinedAt as Date).getUTCMinutes()).toBe(30);
    expect(people.getCell("G7").numFmt).toBe("dd.mm.yyyy hh:mm");
    expect(people.autoFilter).toBeTruthy();
    expect(people.views[0].state).toBe("frozen");
  });
});
