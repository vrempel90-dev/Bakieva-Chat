import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  BOT_TOKEN: z.string().min(10),
  DATABASE_URL: z.string().min(10),
  ADMIN_IDS: z.string().min(1),
  PAID_CHANNEL_ID: z.string().min(1),
  PAID_CHAT_ID: z.string().min(1),
  KASPI_PAY_URL: z.string().url().default("https://pay.kaspi.kz/pay/byqjwvz7"),
  KASPI_MERCHANT_BIN: z.string().regex(/^\\d{12}$/).optional(),
  KASPI_RECEIPT_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(180),
  SUPPORT_PHONE: z.string().default("+77712841932"),
  SUBSCRIPTION_PRICE: z.coerce.number().int().positive().default(5000),
  SUBSCRIPTION_DAYS: z.coerce.number().int().positive().default(30),
  OFFER_URL: z.string().url(),
  PRIVACY_URL: z.string().url(),
  DATA_CONSENT_URL: z.string().url(),
  SUBSCRIPTION_TERMS_URL: z.string().url(),
  FREE_CHANNEL_URL: z.string().url().optional(),
  TRIAL_LESSON_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3000)
});

const env = schema.parse(process.env);

export const config = {
  ...env,
  adminIds: new Set(env.ADMIN_IDS.split(",").map(v => Number(v.trim())).filter(Number.isFinite)),
  paidChannelId: Number(env.PAID_CHANNEL_ID),
  paidChatId: Number(env.PAID_CHAT_ID)
};

export const CONSENT_VERSION = "2026-09-20-v1";
