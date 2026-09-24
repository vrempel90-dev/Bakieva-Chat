import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const environment = {
  BOT_TOKEN: "1234567890:test-token",
  DATABASE_URL: "postgres://localhost/test",
  ADMIN_IDS: "123",
  PAID_CHANNEL_ID: "-1004476014410",
  PAID_CHAT_ID: "-1002222222222",
  PAID_MAIN_CHAT_ID: "-1004333394152",
  TALK_CHAT_ID: "-1004333394152",
  KASPI_MERCHANT_BIN: "123456789012",
  OFFER_URL: "https://example.com/offer",
  PRIVACY_URL: "https://example.com/privacy",
  DATA_CONSENT_URL: "https://example.com/consent",
  SUBSCRIPTION_TERMS_URL: "https://example.com/terms"
};

describe("production configuration errors identify the invalid key", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("allows the operator-confirmed channel and Болталка pairing", async () => {
    const { config } = await import("./config.js");
    expect(config.paidMainChatId).toBe(config.talkChatId);
    expect(config.paidChannelId).not.toBe(config.talkChatId);
  });

  it("names ADMIN_IDS when the configured list has no usable IDs", async () => {
    vi.stubEnv("ADMIN_IDS", "invalid");
    await expect(import("./config.js")).rejects.toThrow("ADMIN_IDS contains no valid Telegram user IDs");
  });

  it("disables the optional legacy chat without blocking new paid targets", async () => {
    vi.stubEnv("PAID_CHAT_ID", "invalid");
    const { config } = await import("./config.js");
    expect(config.paidChatId).toBe(0);
    expect(config.paidChannelId).toBe(-1004476014410);
    expect(config.paidMainChatId).toBe(-1004333394152);
  });

  it("protects the paid channel from being configured as Болталка", async () => {
    vi.stubEnv("PAID_CHANNEL_ID", environment.TALK_CHAT_ID);
    await expect(import("./config.js")).rejects.toThrow("PAID_CHANNEL_ID and TALK_CHAT_ID must differ");
  });
});
