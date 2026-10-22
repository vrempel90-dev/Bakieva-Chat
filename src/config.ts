import "dotenv/config";
import { z } from "zod";
const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const schema = z.object({
  BOT_TOKEN: z.string().min(10),
  DATABASE_URL: z.string().min(10),
  ADMIN_IDS: z.string().regex(/^\s*\d+\s*(,\s*\d+\s*)*$/),
  PAID_CHANNEL_ID: z.string().optional(),
  PAID_CHAT_ID: z.string().optional(),
  NEWS_TARGET_CHAT_IDS: z.string().default(""),
  KASPI_PAY_URL: z.string().url().default("https://pay.kaspi.kz/pay/8j1mpcx4"),
  SUPPORT_PHONE: z.string().default("+77712841932"),
  SUBSCRIPTION_PRICE: z.coerce
    .number()
    .int()
    .min(1)
    .max(100000000)
    .default(5000),
  SUBSCRIPTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  HALF_YEAR_PRICE: z.coerce.number().int().min(1).max(100000000).default(25000),
  HALF_YEAR_DAYS: z.coerce.number().int().min(1).max(3650).default(180),
  SALES_REPORT_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("09:00"),
  OFFER_URL: optionalUrl,
  PRIVACY_URL: optionalUrl,
  DATA_CONSENT_URL: optionalUrl,
  SUBSCRIPTION_TERMS_URL: optionalUrl,
  FREE_CHANNEL_URL: optionalUrl,
  TRIAL_LESSON_URL: optionalUrl,
  PORT: z.coerce.number().int().positive().default(3000),
});

const env = schema.parse(process.env);

export const config = {
  ...env,
  adminIds: new Set(
    env.ADMIN_IDS.split(",")
      .map((v) => Number(v.trim()))
      .filter(Number.isFinite),
  ),
  paidChannelId: env.PAID_CHANNEL_ID ? Number(env.PAID_CHANNEL_ID) : undefined,
  paidChatId: env.PAID_CHAT_ID ? Number(env.PAID_CHAT_ID) : undefined,
  newsTargetChatIds: env.NEWS_TARGET_CHAT_IDS.split(",")
    .map((value) => value.trim())
    .filter((value) => /^-\d+$/.test(value))
    .map(Number)
    .filter(Number.isSafeInteger),
};

if (
  !config.adminIds.size ||
  [...config.adminIds].some((id) => !Number.isSafeInteger(id) || id <= 0)
) {
  throw new Error("ADMIN_IDS must contain positive Telegram IDs");
}
for (const id of [config.paidChannelId, config.paidChatId]) {
  if (id !== undefined && (!Number.isSafeInteger(id) || id >= 0))
    throw new Error("Invalid paid chat ID");
}

export const CONSENT_VERSION = "2026-09-20-v1";
export const DATA_CONSENT_VERSION = "2026-10-22-whatsapp-v1";
