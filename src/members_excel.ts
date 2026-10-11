import ExcelJS from "exceljs";

export type ExportMember = {
  chat_id: string | number;
  user_id: string | number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_member: boolean;
  joined_at: Date | string | null;
  join_source: string | null;
  first_seen_at: Date | string;
  left_at: Date | string | null;
};

export type ExportChat = { id: number; title: string; telegramCount: number | null };

const TIME_ZONE = "Asia/Almaty";
const NAVY = "FF19334F", TEAL = "FF007F86", WHITE = "FFFFFFFF";
const PALE = "FFF8FAFC", GREY = "FF65758B";
const GREEN = "FFE3F5EA", RED = "FFFFE6E5", YELLOW = "FFFFF2D0";
const DATE_FORMAT = "dd.mm.yyyy hh:mm";
const zonedParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

function safeText(value: unknown): string {
  const valueText = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return /^[=+\-@]/.test(valueText) ? "'" + valueText : valueText;
}

function excelDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = Object.fromEntries(
    zonedParts.formatToParts(d).filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)])
  ) as Record<string, number>;
  // Date cells have no timezone. Store the local clock for Asia/Almaty.
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
}

function timeLabel(value: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).format(value);
}

function sourceName(source: string | null): string {
  if (source === "chat_member") return "Событие Telegram";
  if (source === "service_message") return "Сообщение о входе";
  if (source === "mtproto") return "История Telegram";
  return "Неизвестно";
}

export function telegramProfileLink(userId: string | number, username: string | null): string | null {
  const name = (username ?? "").replace(/^@/, "");
  if (/^[a-zA-Z0-9_]{5,32}$/.test(name)) return "https://t.me/" + name;
  const id = String(userId);
  if (/^[1-9]\d{4,19}$/.test(id)) return "tg://user?id=" + id;
  return null;
}

function header(cell: ExcelJS.Cell, fill: string = NAVY) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: WHITE } };
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
}

function title(sheet: ExcelJS.Worksheet, last: string, caption: string) {
  sheet.mergeCells("A1:" + last);
  const cell = sheet.getCell("A1");
  cell.value = caption;
  header(cell);
  cell.font = { name: "Calibri", bold: true, size: 17, color: { argb: WHITE } };
  sheet.getRow(1).height = 45;
}

function bodyCell(cell: ExcelJS.Cell, index: number) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index % 2 ? PALE : WHITE } };
  cell.font = { name: "Calibri", size: 10, color: { argb: NAVY } };
  cell.alignment = { vertical: "middle" };
  cell.border = { bottom: { style: "hair", color: { argb: "FFDAE2E9" } } };
}

function putDate(cell: ExcelJS.Cell, value: Date | string | null, fallback: string) {
  const date = excelDate(value);
  cell.value = date ?? fallback;
  if (date) cell.numFmt = DATE_FORMAT;
  else cell.font = { size: 10, italic: true, color: { argb: GREY } };
}

function putLink(cell: ExcelJS.Cell, caption: string, url: string | null) {
  if (url) {
    cell.value = { text: safeText(caption), hyperlink: url, tooltip: "Открыть Telegram" };
    cell.font = { name: "Calibri", size: 10, bold: true, underline: true, color: { argb: TEAL } };
  } else {
    cell.value = safeText(caption);
  }
}

export async function buildMembersXlsx(
  members: ExportMember[], chats: ExportChat[], generatedAt = new Date()
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Bakieva Chat";
  wb.title = "Bakieva Chat — история участников";
  wb.created = generatedAt;

  const groups = new Map(chats.map(chat => [String(chat.id), chat]));
  for (const member of members) {
    const id = String(member.chat_id);
    if (!groups.has(id)) groups.set(id, { id: Number(id), title: "Чат " + id, telegramCount: null });
  }

  const totalInChat = members.filter(m => m.is_member).length;
  const knownDates = members.filter(m => excelDate(m.joined_at) !== null).length;
  const summary = new Map<string, { total: number; active: number; left: number; known: number }>();
  for (const member of members) {
    const id = String(member.chat_id);
    const s = summary.get(id) ?? { total: 0, active: 0, left: 0, known: 0 };
    s.total++;
    if (member.is_member) s.active++; else s.left++;
    if (excelDate(member.joined_at)) s.known++;
    summary.set(id, s);
  }

  const dashboard = wb.addWorksheet("Сводка", { views: [{ state: "frozen", ySplit: 7 }] });
  dashboard.columns = [
    { width: 36 }, { width: 23 }, { width: 17 }, { width: 17 },
    { width: 15 }, { width: 19 }, { width: 20 }, { width: 21 }
  ];
  title(dashboard, "H1", "BAKIEVA CHAT  |  УЧЁТ УЧАСТНИКОВ");
  dashboard.mergeCells("A2:H2");
  dashboard.getCell("A2").value = "Обновлено: " + timeLabel(generatedAt) + " (Алматы)";
  dashboard.getCell("A2").font = { size: 11, color: { argb: GREY } };
  dashboard.getRow(2).height = 27;
  const overview: Array<[string, string, string, number]> = [
    ["A4", "Всего записей:", "B4", members.length],
    ["D4", "Сейчас в чатах:", "E4", totalInChat],
    ["G4", "Дата известна:", "H4", knownDates]
  ];
  for (const [labelAddress, caption, valueAddress, number] of overview) {
    dashboard.getCell(labelAddress).value = caption;
    dashboard.getCell(labelAddress).font = { size: 11, bold: true, color: { argb: NAVY } };
    dashboard.getCell(valueAddress).value = number;
    dashboard.getCell(valueAddress).font = { size: 17, bold: true, color: { argb: TEAL } };
  }
  dashboard.getRow(4).height = 37;
  dashboard.mergeCells("A6:H6");
  dashboard.getCell("A6").value = "Статистика по группам и каналам";
  dashboard.getCell("A6").font = { bold: true, size: 13, color: { argb: NAVY } };
  dashboard.getRow(7).values = [
    "Группа / канал", "ID чата", "Записей", "В чате", "Вышли",
    "Дата известна", "Дата неизвестна", "Всего в Telegram"
  ];
  dashboard.getRow(7).height = 39;
  dashboard.getRow(7).eachCell(c => header(c));
  const sortedGroups = [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, "ru"));
  sortedGroups.forEach((group, index) => {
    const s = summary.get(String(group.id)) ?? { total: 0, active: 0, left: 0, known: 0 };
    const row = dashboard.getRow(8 + index);
    row.values = [
      safeText(group.title), String(group.id), s.total, s.active, s.left, s.known,
      s.total - s.known, group.telegramCount ?? "Нет данных"
    ];
    row.height = 27;
    row.eachCell({ includeEmpty: true }, cell => bodyCell(cell, index));
    row.getCell(2).numFmt = "@";
    if (s.total > s.known) row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
  });
  const note = 10 + sortedGroups.length;
  const notes = [
    "1 человек в двух чатах учитывается дважды — отдельно в каждом чате.",
    "Дата «Впервые обнаружен» не равна фактической дате вступления.",
    "Телеграм может ограничить доступ к истории; реестр может быть неполным.",
    "Полный список с фильтрами и ссылками — на вкладке «Участники»."
  ];
  notes.forEach((line, index) => {
    const number = note + index;
    dashboard.mergeCells("A" + number + ":H" + number);
    const cell = dashboard.getCell("A" + number);
    cell.value = line;
    cell.font = { name: "Calibri", italic: index < 3, bold: index === 3, size: 10, color: { argb: index === 3 ? TEAL : GREY } };
    dashboard.getRow(number).height = 24;
  });

  const list = wb.addWorksheet("Участники", { views: [{ state: "frozen", xSplit: 3, ySplit: 6 }] });
  list.columns = [
    { width: 7 }, { width: 32 }, { width: 27 }, { width: 23 },
    { width: 23 }, { width: 17 }, { width: 23 }, { width: 26 },
    { width: 23 }, { width: 21 }, { width: 23 }, { width: 21 }
  ];
  title(list, "L1", "BAKIEVA CHAT  |  РЕЕСТР УЧАСТНИКОВ");
  list.mergeCells("A2:L2");
  list.getCell("A2").value = "Записей: " + members.length + "  •  В чатах: " + totalInChat +
    "  •  С датой входа: " + knownDates + "  •  Выгружено: " + timeLabel(generatedAt) + " (Алматы)";
  list.getCell("A2").font = { bold: true, size: 11, color: { argb: NAVY } };
  list.getRow(2).height = 25;
  list.mergeCells("A3:L3");
  list.getCell("A3").value = "Нажмите «✉ Написать» или имя участника. Ссылки по Telegram ID без @username могут открываться не у всех.";
  list.getCell("A3").font = { size: 11, color: { argb: GREY } };
  list.getRow(3).height = 26;
  list.mergeCells("A4:L4");
  list.getCell("A4").value = "«Неизвестно» — нет подтверждённой даты входа. «Впервые обнаружен» — время первой записи в базе.";
  list.getCell("A4").font = { size: 10, italic: true, color: { argb: GREY } };
  list.getRow(4).height = 24;

  list.getRow(6).values = [
    "№", "Группа / канал", "Имя участника", "Username", "Telegram ID",
    "Статус", "Дата входа (Алматы)", "Впервые обнаружен (Алматы)",
    "Дата выхода (Алматы)", "Источник даты", "✉ Написать", "ID чата"
  ];
  list.getRow(6).height = 44;
  list.getRow(6).eachCell(c => header(c, TEAL));

  const sorted = [...members].sort((a, b) => {
    const first = new Date(a.joined_at ?? a.first_seen_at).getTime();
    const second = new Date(b.joined_at ?? b.first_seen_at).getTime();
    return (Number.isFinite(second) ? second : 0) - (Number.isFinite(first) ? first : 0);
  });
  sorted.forEach((m, index) => {
    const row = list.getRow(index + 7);
    const name = [m.first_name, m.last_name].filter(Boolean).map(safeText).join(" ") || "Без имени";
    const link = telegramProfileLink(m.user_id, m.username);
    row.values = [
      index + 1,
      safeText(groups.get(String(m.chat_id))?.title ?? "Чат " + m.chat_id),
      name,
      m.username ? "@" + safeText(m.username.replace(/^@/, "")) : "—",
      String(m.user_id),
      m.is_member ? "В чате" : "Вышел", null, null, null,
      sourceName(m.join_source), link ? "✉ Написать" : "Нет ссылки", String(m.chat_id)
    ];
    row.height = 25;
    row.eachCell({ includeEmpty: true }, cell => bodyCell(cell, index));
    putLink(row.getCell(3), name, link);
    if (m.username) putLink(row.getCell(4), "@" + m.username.replace(/^@/, ""), link);
    putLink(row.getCell(11), link ? "✉ Написать" : "Нет ссылки", link);
    row.getCell(5).numFmt = "@";
    row.getCell(12).numFmt = "@";
    row.getCell(6).fill = { type: "pattern", pattern: "solid", fgColor: { argb: m.is_member ? GREEN : RED } };
    row.getCell(6).font = { bold: true, size: 10, color: { argb: m.is_member ? "FF166534" : "FF991B1B" } };
    putDate(row.getCell(7), m.joined_at, "Неизвестно");
    putDate(row.getCell(8), m.first_seen_at, "Нет данных");
    putDate(row.getCell(9), m.left_at, "—");
    if (!excelDate(m.joined_at)) {
      row.getCell(7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };
    }
  });
  // Filter only data rows; freeze keeps the name/ID visible when scrolling.
  list.autoFilter = { from: { row: 6, column: 1 }, to: { row: Math.max(7, sorted.length + 6), column: 12 } };
  list.printTitlesRow = "1:6";
  return Buffer.from(await wb.xlsx.writeBuffer());
}
