import { UserError } from "./errors.js";
import type { Bot } from "grammy";
import { revokeSubscription } from "./commerce.js";
import { removeAccess } from "./access.js";
import { withUserLock } from "./transaction.js";

export async function anonymizeBuyer(bot: Bot, userId: number) {
  await revokeSubscription(userId);
  if (!(await removeAccess(bot, userId)))
    throw new UserError(
      "Удаление доступа не завершено. Повторите запрос позже",
    );
  await withUserLock(userId, async (c) => {
    const active = await c.query(
      "SELECT 1 FROM subscriptions WHERE user_id=$1 AND status='active'",
      [userId],
    );
    if (active.rowCount)
      throw new UserError("Состояние подписки изменилось. Повторите удаление");
    // Financial totals/history survive, with no link to the former Telegram identity.
    await c.query(
      `UPDATE payments SET buyer_name=NULL,buyer_username=NULL,whatsapp=NULL,
      whatsapp_provided_at=NULL,data_consent_at=NULL,data_consent_version=NULL,
      marketing_opt_in=FALSE,marketing_consented_at=NULL,meta='{}'::jsonb WHERE user_id=$1`,
      [userId],
    );
    await c.query("DELETE FROM chat_memberships WHERE user_id=$1", [userId]);
    await c.query("DELETE FROM membership_events WHERE user_id=$1", [userId]);
    await c.query("DELETE FROM admin_actions WHERE user_id=$1 OR admin_id=$1", [
      userId,
    ]);
    await c.query("DELETE FROM admin_flows WHERE admin_id=$1", [userId]);
    // Stored report payloads contain snapshots of personal information. Invalidate all
    // snapshots that reference this identity; already delivered exports require owner handling.
    const reports = await c.query(
      `UPDATE report_parts SET payload='{"kind":"text","text":"Снимок отчёта удалён по запросу на обезличивание. Сформируйте отчёт заново."}'::jsonb,
      status=CASE WHEN status='sent' THEN 'sent' ELSE 'uncertain' END
      WHERE payload::text LIKE $1 RETURNING delivery_id`,
      ["%" + userId + "%"],
    );
    for (const r of reports.rows)
      await c.query(
        "UPDATE report_deliveries SET status='uncertain' WHERE id=$1 AND status<>'sent'",
        [r.delivery_id],
      );
    await c.query("DELETE FROM users WHERE telegram_id=$1", [userId]);
  });
}
