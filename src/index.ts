import { healthServer } from "./health.js";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";
import { seedPlans } from "./commerce.js";

await migrate();
await seedPlans();
const bot = createBot();
let pollingReady = false;
let stopScheduler: (() => Promise<void>) | undefined;
let stopping = false;
const server = healthServer(
  () => pool.query("SELECT 1"),
  () => pollingReady,
);
server.listen(config.PORT, "0.0.0.0", () =>
  console.log(`Health server listening on :${config.PORT}`),
);

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  pollingReady = false;
  server.close();
  if (bot.isRunning()) await bot.stop();
  await stopScheduler?.();
  await pool.end();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  try {
    await bot.api.setMyName("Bakieva Chat | Вступить в чат");
    await bot.api.setMyCommands([
      { command: "start", description: "Запустить бота" },
      { command: "menu", description: "Открыть меню" },
      {
        command: "access",
        description: "Продолжить покупку / обновить приглашения",
      },
      { command: "whatsapp", description: "Обновить WhatsApp" },
      { command: "unsubscribe", description: "Отписаться от рассылки" },
      {
        command: "subscribe",
        description: "Добровольно подписаться на рассылку",
      },
      { command: "delete_data", description: "Обезличить мои данные" },
    ]);
  } catch {
    console.warn(
      "Could not update Telegram bot profile; polling will still start",
    );
  }
  await bot.start({
    drop_pending_updates: false,
    allowed_updates: [
      "message",
      "callback_query",
      "chat_join_request",
      "chat_member",
      "my_chat_member",
    ],
    onStart: (info) => {
      pollingReady = true;
      stopScheduler = startScheduler(bot);
      console.log(`Logged in as @${info.username}`);
    },
  });
} catch {
  console.error("Bot polling stopped unexpectedly");
  process.exitCode = 1;
} finally {
  await shutdown();
}
