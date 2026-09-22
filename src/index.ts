import { createServer } from "node:http";
import { config } from "./config.js";
import {
  getTrialPdfAsset,
  getTrialVideoAsset,
  migrate,
  pool,
  setSetting,
  upsertTrialPdfContent,
  upsertTrialVideoContent
} from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";
import { handleInstagramWebhook } from "./instagram_service.js";

await migrate();

async function seedTrialVideo(language: "ru" | "kk", url: string | undefined) {
  if (!url) return;
  const existing = await getTrialVideoAsset(language);
  if (existing?.content?.length) return;

  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Seed ${language} video HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength && contentLength > 49 * 1024 * 1024) {
    throw new Error(`Seed ${language} video too large`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 49 * 1024 * 1024) {
    throw new Error(`Seed ${language} video invalid size`);
  }
  await upsertTrialVideoContent(language, bytes, "video/mp4");
  console.log(`Seeded ${language} trial video (${bytes.length} bytes)`);
}

try {
  await seedTrialVideo("ru", process.env.TRIAL_VIDEO_SEED_RU_URL);
  await seedTrialVideo("kk", process.env.TRIAL_VIDEO_SEED_KK_URL);
} catch (error) {
  console.error("Trial video seeding failed", error);
}


async function replaceTrialVideo(language: "ru" | "kk", url: string | undefined) {
  if (!url) return;

  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Replace ${language} video HTTP ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 49 * 1024 * 1024) {
    throw new Error(`Replace ${language} video invalid size: ${bytes.length}`);
  }

  await upsertTrialVideoContent(language, bytes, "video/mp4");
  await setSetting(`trial_video_file_id_${language}`, "");
  console.log(`Replaced ${language} trial video (${bytes.length} bytes)`);
}

try {
  await replaceTrialVideo("kk", process.env.TRIAL_VIDEO_REPLACE_KK_URL);
} catch (error) {
  console.error("Kazakh trial video replacement failed", error);
}


async function seedTrialPdf(
  language: "ru" | "kk",
  url: string | undefined,
  filename: string
) {
  if (!url) return;

  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Seed ${language} PDF HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new Error(`Seed ${language} PDF invalid size`);
  }
  if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`Seed ${language} file is not a PDF`);
  }

  await upsertTrialPdfContent(language, bytes, filename, "application/pdf");
  console.log(`Seeded ${language} trial PDF (${bytes.length} bytes)`);
}

try {
  await seedTrialPdf(
    "ru",
    process.env.TRIAL_PDF_SEED_RU_URL,
    "Клубничка, рус.pdf"
  );
  await seedTrialPdf(
    "kk",
    process.env.TRIAL_PDF_SEED_KK_URL,
    "Клубничка, кз.pdf"
  );
} catch (error) {
  console.error("Trial PDF seeding failed", error);
}

const bot = createBot();
startScheduler(bot);

const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/webhooks/instagram")) {
    await handleInstagramWebhook(req, res);
    return;
  }

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
