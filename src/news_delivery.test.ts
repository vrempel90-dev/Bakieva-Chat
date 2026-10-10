import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";

vi.mock("./config.js", () => ({
  config: { newsTargetChatIds: [-1001111111111, -1001111111111, -1003333333333] }
}));
vi.mock("./db.js", () => ({
  getPaidChannelId: vi.fn(async () => -1001111111111),
  getPaidChatId: vi.fn(async () => -1002222222222),
  getPaidMainChatId: vi.fn(async () => -1002222222222),
  recordContentNewsDelivery: vi.fn(async () => undefined)
}));

import {
  deduplicateNewsTargets,
  resolveNewsTargets,
  formatGroupDeliveryReport,
  newsMessageLink,
  publishNewsToGroups
} from "./news_delivery.js";
import { recordContentNewsDelivery } from "./db.js";

const basePost = {
  id: 99,
  body: "Новость для сообщества",
  telegramFileId: null,
  telegramMediaType: null
};

afterEach(() => vi.clearAllMocks());

describe("Telegram group news publication", () => {
  it("deduplicates live bindings and explicit extra channels", async () => {
    expect(deduplicateNewsTargets([-1001, -1001, 0, 12345, -1002]))
      .toEqual([-1001, -1002]);
    expect(await resolveNewsTargets())
      .toEqual([-1001111111111, -1002222222222, -1003333333333]);
  });

  it("builds links from Telegram message IDs, not guessed publication results", () => {
    expect(newsMessageLink({
      chatId: -1001111111111, title: "Private", username: null,
      status: "sent", messageId: 12, error: null
    })).toBe("https://t.me/c/1111111111/12");
    expect(newsMessageLink({
      chatId: -1001111111111, title: "Public", username: "bakieva_news",
      status: "sent", messageId: 12, error: null
    })).toBe("https://t.me/bakieva_news/12");
    expect(newsMessageLink({
      chatId: -1001111111111, title: "Failed", username: null,
      status: "failed", messageId: null, error: "Forbidden"
    })).toBeNull();
  });

  it("reports delivery success and failure separately by group", () => {
    const report = formatGroupDeliveryReport(99, [
      {
        chatId: -1001111111111, title: "Рабочий канал", username: null,
        status: "sent", messageId: 15, error: null
      },
      {
        chatId: -1002222222222, title: "Другая группа", username: null,
        status: "failed", messageId: null, error: "Telegram 403: Forbidden"
      }
    ]);
    expect(report).toContain("успешно 1 из 2");
    expect(report).toContain("Рабочий канал");
    expect(report).toContain("Другая группа");
    expect(report).toContain("Telegram 403: Forbidden");
    expect(report).toContain("https://t.me/c/1111111111/15");
  });

  it("sends real messages and logs the returned Telegram IDs", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 101 }));
    const bot = { api: {
      getChat: vi.fn(async () => ({ title: "Тест", username: "news_testing" })),
      sendMessage
    }} as unknown as Bot;
    const result = await publishNewsToGroups(bot, basePost, [-1001111111111]);
    expect(sendMessage).toHaveBeenCalledWith(-1001111111111, basePost.body);
    expect(result[0]).toMatchObject({ status: "sent", messageId: 101 });
    expect(vi.mocked(recordContentNewsDelivery)).toHaveBeenCalledWith(99, result[0]);
  });

  it("does not report success when Telegram denies publication", async () => {
    const bot = { api: {
      getChat: vi.fn(async () => ({ title: "Нет прав" })),
      sendMessage: vi.fn(async () => { throw new Error("Forbidden: bot is not an administrator"); })
    }} as unknown as Bot;
    const result = await publishNewsToGroups(bot, basePost, [-1001111111111]);
    expect(result[0].status).toBe("failed");
    expect(result[0].messageId).toBeNull();
    expect(result[0].error).toContain("Forbidden");
  });

  it("marks multipart posts as partial if a later message fails", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ message_id: 515 })
      .mockRejectedValueOnce(new Error("Telegram timed out"));
    const bot = { api: {
      getChat: vi.fn(async () => ({ title: "Тест" })),
      sendMessage
    }} as unknown as Bot;
    const result = await publishNewsToGroups(bot, {
      ...basePost, body: "X".repeat(4500)
    }, [-1001111111111]);
    expect(result[0]).toMatchObject({
      status: "partial", messageId: 515, error: "Telegram timed out"
    });
  });
  it("publishes video news to groups with Telegram-confirmed IDs", async () => {
    const sendVideo = vi.fn(async () => ({ message_id: 777 }));
    const bot = { api: {
      getChat: vi.fn(async () => ({ title: "Видео чат" })),
      sendVideo, sendMessage: vi.fn()
    }} as unknown as Bot;
    const result = await publishNewsToGroups(bot, {
      ...basePost, body: "Видео новость", telegramFileId: "tg-video-file", telegramMediaType: "video"
    }, [-1001111111111]);
    expect(sendVideo).toHaveBeenCalledWith(-1001111111111, "tg-video-file", {
      caption: "Видео новость"
    });
    expect(result[0]).toMatchObject({ status: "sent", messageId: 777 });
  });

  it("sends original-quality videos as documents", async () => {
    const sendDocument = vi.fn(async () => ({ message_id: 888 }));
    const bot = { api: {
      getChat: vi.fn(async () => ({ title: "Файлы" })),
      sendDocument, sendMessage: vi.fn()
    }} as unknown as Bot;
    const result = await publishNewsToGroups(bot, {
      ...basePost, body: "Без сжатия", telegramFileId: "tg-document-file",
      telegramMediaType: "document"
    }, [-1001111111111]);
    expect(sendDocument).toHaveBeenCalledWith(-1001111111111, "tg-document-file", {
      caption: "Без сжатия"
    });
    expect(result[0].status).toBe("sent");
  });

});
