import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  BOT_TOKEN: z.string().min(10),
  DATABASE_URL: z.string().min(10),
  ADMIN_IDS: z.string().min(1),
  PAID_CHANNEL_ID: z.string().min(1).optional(),
  PAID_CHAT_ID: z.string().min(1).optional(),
  KASPI_PAY_URL: z.string().url().default("https://pay.kaspi.kz/pay/byqjwvz7"),
  TRIBUTE_PAYMENT_URL: z.string().url().default("https://t.me/tribute/app?startapp=s14Dc"),
  SUPPORT_PHONE: z.string().default("+77712841932"),
  SUBSCRIPTION_PRICE: z.coerce.number().int().positive().default(5000),
  SUBSCRIPTION_DAYS: z.coerce.number().int().positive().default(30),
  OFFER_URL: z.string().url().optional(),
  PRIVACY_URL: z.string().url().optional(),
  DATA_CONSENT_URL: z.string().url().optional(),
  SUBSCRIPTION_TERMS_URL: z.string().url().optional(),
  FREE_CHANNEL_URL: z.string().url().optional(),
  TRIAL_LESSON_URL: z.string().url().optional(),
  PORT: z.coerce.number().int().positive().default(3000)
});

const env = schema.parse(process.env);

export const config = {
  ...env,
  adminIds: new Set(env.ADMIN_IDS.split(",").map(v => Number(v.trim())).filter(Number.isFinite)),
  paidChannelId: env.PAID_CHANNEL_ID ? Number(env.PAID_CHANNEL_ID) : undefined,
  paidChatId: env.PAID_CHAT_ID ? Number(env.PAID_CHAT_ID) : undefined
};

export const CONSENT_VERSION = "2026-09-20-v1";
