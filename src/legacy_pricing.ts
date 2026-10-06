import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { getPaidChatId, getSetting, setSetting } from "./db.js";

const NOTICE_SETTING = "legacy_5000_claim_notice_v2_sent_at";

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
      "💗 ВАЖНО ДЛЯ ТЕХ, КТО УЖЕ БЫЛ В BAKIEVA CHAT ПО ТАРИФУ 5 000 ₸",
      "",
      "Для вас старая цена сохраняется — 5 000 ₸ за 30 дней.",
      "",
      "Чтобы бот закрепил этот тариф именно за вашим Telegram-аккаунтом, нажмите кнопку ниже.",
      "Бот проверит, что этот аккаунт уже состоит в старом платном чате, и сохранит тариф 5 000 ₸ для следующих продлений.",
      "",
      "После подтверждения цена для вашего аккаунта не изменится.",
      "",
      "Новые участники, которые заходят после перехода на новые цены, оплачивают:",
      "• 10 000 ₸ — 30 дней",
      "• 25 000 ₸ — 5 месяцев",
      "",
      "Если вы старый участник — обязательно нажмите кнопку ниже 👇",
      "",
      "💗 БҰРЫН 5 000 ₸ ТАРИФІМЕН BAKIEVA CHAT-ТА БОЛҒАН ҚАТЫСУШЫЛАР ҮШІН",
      "",
      "Сіз үшін бұрынғы баға сақталады — 30 күнге 5 000 ₸.",
      "Тарифті Telegram аккаунтыңызға бекіту үшін төмендегі батырманы басыңыз."
    ].join("\n"),
    {
      reply_markup: new InlineKeyboard().url(
        "✅ Сохранить мой тариф 5 000 ₸",
        claimUrl
      )
    }
  );

  await setSetting(NOTICE_SETTING, new Date().toISOString());
  return { sent: true as const };
}
