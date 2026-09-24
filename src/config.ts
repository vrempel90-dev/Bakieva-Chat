import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  BOT_TOKEN: z.string().min(10),
  DATABASE_URL: z.string().min(10),
  ADMIN_IDS: z.string().min(1),
  PAID_CHANNEL_ID: z.string().min(1),
  PAID_CHAT_ID: z.string().min(1),
  PAID_MAIN_CHAT_ID: z.string().regex(/^-\d+$/).optional(),
  TALK_CHAT_ID: z.string().regex(/^-\d+$/).optional(),
  KASPI_PAY_URL: z.string().url().default("https://pay.kaspi.kz/pay/byqjwvz7"),
  KASPI_MERCHANT_BIN: z.string().regex(/^\d{12}$/),
  KASPI_RECEIPT_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(1440),
  OPENAI_API_KEY: z.string().min(20).optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5.6-luna"),
  META_APP_ID: z.string().min(1).optional(),
  META_APP_SECRET: z.string().min(8).optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8).optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().min(10).optional(),
  INSTAGRAM_IG_USER_ID: z.string().min(1).optional(),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  RAILWAY_PUBLIC_DOMAIN: z.string().min(1).optional(),
  SUPPORT_PHONE: z.string().default("+77712841932"),
  SUBSCRIPTION_PRICE: z.coerce.number().int().positive().default(5000),
  SUBSCRIPTION_DAYS: z.coerce.number().int().positive().default(30),
  OFFER_URL: z.string().url(),
  PRIVACY_URL: z.string().url(),
  DATA_CONSENT_URL: z.string().url(),
  SUBSCRIPTION_TERMS_URL: z.string().url(),
  FREE_CHANNEL_URL: z.string().url().optional(),
  TRIAL_LESSON_URL: z.string().url().optional(),
  ADMIN_REPORT_HOUR: z.coerce.number().int().min(0).max(23).default(21),
  ADMIN_TIMEZONE: z.string().default("Asia/Almaty"),
  PORT: z.coerce.number().int().positive().default(3000)
});

const env = schema.parse(process.env);

export const config = {
  ...env,
  adminIds: new Set(
    env.ADMIN_IDS.split(",")
      .map(v => Number(v.trim()))
      .filter(v => Number.isSafeInteger(v) && v > 0)
  ),
  paidChannelId: Number(env.PAID_CHANNEL_ID),
  paidChatId: Number(env.PAID_CHAT_ID),
  paidMainChatId: Number(env.PAID_MAIN_CHAT_ID ?? 0),
  talkChatId: Number(env.TALK_CHAT_ID ?? 0)
};

if (!config.adminIds.size || !Number.isSafeInteger(config.paidChannelId) || !config.paidChannelId ||
    !Number.isSafeInteger(config.paidChatId) || !config.paidChatId ||
    (config.talkChatId && config.paidChannelId === config.talkChatId)) {
  throw new Error("Invalid ADMIN_IDS or paid target configuration");
}

export const CONSENT_VERSION = "2026-09-20-v1";
