// Never load production credentials or Telegram destinations during tests.
if (process.env.TEST_DATABASE_URL) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    !/^\/bakieva_test[A-Za-z0-9_]*$/.test(url.pathname)
  ) {
    throw new Error("Tests require an isolated local bakieva_test database");
  }
}
Object.assign(process.env, {
  BOT_TOKEN: "123456789:TEST_TOKEN_NO_NETWORK",
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://test:test@localhost/bakieva_test",
  ADMIN_IDS: "1",
  PAID_CHANNEL_ID: "-100111",
  PAID_CHAT_ID: "-100222",
  NEWS_TARGET_CHAT_IDS: "-100333",
  OFFER_URL: "https://example.test/offer",
  PRIVACY_URL: "https://example.test/privacy",
  DATA_CONSENT_URL: "https://example.test/data",
  SUBSCRIPTION_TERMS_URL: "https://example.test/terms",
});
