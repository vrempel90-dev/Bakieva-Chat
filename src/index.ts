import { createServer } from "node:http";
import { InputFile } from "grammy";
import { config } from "./config.js";
import { getPaidChatId, migrate, pool, setSetting } from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";

await migrate();

const bot = createBot();
startScheduler(bot);

const MAX_TRIAL_VIDEO_BYTES = 49 * 1024 * 1024;

async function readRequestBody(req: import("node:http").IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("payload_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

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

  const parsed = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "POST" && parsed.pathname === "/internal/trial-video") {
    const secret = process.env.TRIAL_UPLOAD_SECRET ?? "";
    const provided = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!secret || provided !== secret) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const lang = parsed.searchParams.get("lang");
    if (lang !== "ru" && lang !== "kk") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "lang_must_be_ru_or_kk" }));
      return;
    }

    try {
      const contentLength = Number(req.headers["content-length"] ?? "0");
      if (contentLength > MAX_TRIAL_VIDEO_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "video_too_large" }));
        return;
      }

      const paidChatId = await getPaidChatId();
      if (!paidChatId) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "paid_chat_not_bound" }));
        return;
      }

      const video = await readRequestBody(req, MAX_TRIAL_VIDEO_BYTES);
      if (video.length === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "empty_video" }));
        return;
      }

      const filename = lang === "ru"
        ? "Bakieva_Chat_Clubnichka_RU.mp4"
        : "Bakieva_Chat_Qulpunai_KK.mp4";
      const caption = lang === "ru"
        ? "🎬 Бесплатный пробный урок «Клубничка» — русский язык"
        : "🎬 «Құлпынай» тегін сынақ сабағы — қазақ тілі";

      const message = await bot.api.sendVideo(
        paidChatId,
        new InputFile(video, filename),
        {
          caption,
          supports_streaming: true
        }
      );

      if (!message.video) throw new Error("telegram_video_missing");
      await setSetting(`trial_video_file_id_${lang}`, message.video.file_id);
      await setSetting(`trial_video_message_id_${lang}`, String(message.message_id));

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        lang,
        chatId: paidChatId,
        messageId: message.message_id,
        fileId: message.video.file_id
      }));
    } catch (error) {
      console.error("Trial video upload endpoint failed", error);
      const status = error instanceof Error && error.message === "payload_too_large" ? 413 : 500;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "upload_failed" }));
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
    { command: "unsubscribe", description: "Отключить уведомления / Хабарландыруларды өшіру" },
    { command: "subscribe", description: "Включить уведомления / Хабарландыруларды қосу" },
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
