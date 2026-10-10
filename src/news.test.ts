import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  config: {
    adminIds: new Set([1]),
    paidChannelId: -1001234567890,
    paidChatId: -1009876543210,
    newsTargetChatIds: [-1001234567890, -1004444444444]
  }
}));
vi.mock("./db.js", () => ({
  createNewsPublication: vi.fn(),
  getLatestNewsPublication: vi.fn(),
  recordNewsDelivery: vi.fn()
}));

import { newsTargets, postUrl } from "./news.js";
import type { NewsDelivery } from "./db.js";

const sent: NewsDelivery = {
  chatId: -1001234567890,
  title: "Тестовая группа",
  username: null,
  status: "sent",
  messageId: 57,
  error: null
};

describe("admin news delivery", () => {
  it("deduplicates paid and extra destination IDs", () => {
    expect(newsTargets()).toEqual([
      -1001234567890,
      -1009876543210,
      -1004444444444
    ]);
  });

  it("links to messages in private channels and supergroups", () => {
    expect(postUrl(sent)).toBe("https://t.me/c/1234567890/57");
  });

  it("prefers public channel usernames when available", () => {
    expect(postUrl({ ...sent, username: "bakieva_news" }))
      .toBe("https://t.me/bakieva_news/57");
  });

  it("never creates links for failed deliveries", () => {
    expect(postUrl({ ...sent, status: "failed", messageId: null }))
      .toBeNull();
  });

  it("does not fabricate message links for ordinary groups", () => {
    expect(postUrl({ ...sent, chatId: -123456 }))
      .toBeNull();
  });
});
