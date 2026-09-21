import { createServer } from "node:http";
import { config } from "./config.js";
import { migrate, pool } from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";

await migrate();

const bot = createBot();
startScheduler(bot);

const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/readyz") {
    try {
      await pool.query("SELECT 1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(config.PORT, "0.0.0.0", () => {
  console.log(`Health server listening on :${config.PORT}`);
});

const shutdown = async () => {
  server.close();
  bot.stop();
  await pool.end();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await bot.api.setMyCommands([
    { command: "start", description: "Запустить / Бастау" },
    { command: "menu", description: "Меню / Мәзір" },
    { command: "language", description: "Сменить язык / Тілді өзгерту" },
    { command: "unsubscribe", description: "Отключить уведомления / Хабарламаларды өшіру" },
    { command: "subscribe", description: "Включить уведомления / Хабарламаларды қосу" },
    { command: "myid", description: "Мой Telegram ID / Менің Telegram ID" }
  ]);
} catch (error) {
  console.warn("Could not refresh Telegram commands; continuing startup.", error);
}

console.log("Bakieva Chat bot started");
await bot.start({
  drop_pending_updates: false,
  onStart: info => console.log(`Logged in as @${info.username}`)
});
