import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getPaidChatId, getSetting, setSetting } from "./db.js";

const NOTICE_SETTING = "legacy_5000_claim_notice_sent_at";

export async function sendLegacy5000ClaimNotice(
  bot: Bot,
  options: { force?: boolean } = {}
) {
  const closedAt = await getSetting("legacy_5000_claim_closed_at", "");
  if (closedAt) return { sent: false as const, reason: "closed" as const };

  if (!options.force) {
    const alreadySent = await getSetting(NOTICE_SETTING, "");
    if (alreadySent) return { sent: false as const, reason: "already_sent" as const };
  }

  const paidChatId = await getPaidChatId();
  if (!paidChatId) return { sent: false as const, reason: "chat_not_configured" as const };

  const me = await bot.api.getMe();
  const claimUrl = `https://t.me/${me.username}?start=legacy5000`;

  await bot.api.sendMessage(
    paidChatId,
    [
      "💗 Важно для старых участников Bakieva Chat",
      "",
      "Если вы были участником Bakieva Chat на старом тарифе 5 000 ₸ в месяц, мы сохраняем эту цену за вами.",
      "Нажмите кнопку ниже тем Telegram-аккаунтом, который находится в этом платном чате.",
      "Бот проверит ваше участие и закрепит персональный тариф 5 000 ₸ за 30 дней за вашим Telegram ID для следующих продлений.",
      "",
      "Новые участники остаются на новых тарифах 10 000 ₸ / месяц или 25 000 ₸ / 5 месяцев.",
      "",
      "💗 Bakieva Chat-тың бұрынғы қатысушылары үшін маңызды",
      "",
      "Егер сіз бұрын айына 5 000 ₸ тарифімен қатысқан болсаңыз, бұл баға сіз үшін сақталады.",
      "Төмендегі батырманы осы ақылы чаттағы Telegram аккаунтыңызбен басыңыз.",
      "Бот қатысуыңызды тексеріп, 30 күнге 5 000 ₸ жеке тарифті Telegram ID-іңізге бекітеді."
    ].join("\n"),
    {
      reply_markup: new InlineKeyboard().url(
        "✅ Сохранить тариф 5 000 ₸ / Тарифті сақтау",
        claimUrl
      )
    }
  );

  await setSetting(NOTICE_SETTING, new Date().toISOString());
  return { sent: true as const };
}
