import type { PoolClient } from "pg";
import { createServer, type IncomingMessage } from "node:http";
import { InputFile } from "grammy";
import { config } from "./config.js";
import {
  getPaidMainChatId,
  getPaidChannelId,
  getPaidChatId,
  getSetting,
  getTrialPdfAsset,
  getTrialVideoAsset,
  migrate,
  pool,
  publishTrialVideoPair,
  setSetting,
  setTrialVideoTelegramFileId,
  upsertTrialPdfContent,
  upsertTrialVideoContent
} from "./db.js";
import { createBot } from "./bot.js";
import { checkAccessTargets } from "./access.js";
import { startScheduler } from "./scheduler.js";
import { acquireSingletonLock } from "./singleton.js";
import { handleInstagramWebhook } from "./instagram_service.js";
import { handleInstagramReelSource } from "./instagram_reels.js";

await migrate();

async function syncExistingTrialVideoUpload(language: "ru" | "kk") {
  const fileId = (await getSetting(`trial_video_file_id_${language}`, "")).trim();
  if (!fileId) return;

  await setTrialVideoTelegramFileId(language, fileId);
  console.log(`Synced existing ${language} trial video upload into trial_video_assets`);
}

try {
  await syncExistingTrialVideoUpload("ru");
  await syncExistingTrialVideoUpload("kk");
} catch (error) {
  console.error("Existing trial video upload sync failed", error);
}

async function seedTrialVideo(language: "ru" | "kk", url: string | undefined) {
  if (!url) return;
  const existing = await getTrialVideoAsset(language);
  if (existing?.content?.length || existing?.telegramFileId) return;

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



async function seedTrialPdf(
  language: "ru" | "kk",
  url: string | undefined,
  filename: string
) {
  if (!url) return;
  const existing = await getTrialPdfAsset(language);
  if (existing?.content?.length || existing?.telegramFileId) return;

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
let botLockClient: PoolClient | null = null;
const shutdownSignal = new AbortController();
let pollerActive = false;
let stopScheduler: (() => void) | null = null;

async function acquireBotInstanceLock() {
  botLockClient = await acquireSingletonLock(pool, 834271, shutdownSignal.signal);
  console.log("Telegram poller lock acquired");
}

async function readRequestBody(req: IncomingMessage, maxBytes = 49 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("upload_too_large");
    }
    chunks.push(buffer);
  }

  if (total === 0) throw new Error("empty_upload");
  return Buffer.concat(chunks);
}

async function activateUploadedTrialPart(
  language: "ru" | "kk",
  part: "part1" | "part2",
  bytes: Buffer
) {
  const adminId = [...config.adminIds][0];
  if (!adminId) throw new Error("No admin ID configured");

  if (part === "part2") {
    const pending = await getSetting(`trial_video_pending_${language}_part1`, "");
    if (!pending) throw new Error("part1_missing");
  }

  const label = language === "ru"
    ? (part === "part1" ? "Русский пробный урок — часть 1/2" : "Русский пробный урок — часть 2/2")
    : (part === "part1" ? "Қазақша сынақ сабағы — 1/2" : "Қазақша сынақ сабағы — 2/2");

  const uploaded = await bot.api.sendVideo(
    adminId,
    new InputFile(bytes, `trial_${language}_${part}.mp4`),
    { caption: `⬆️ Служебная загрузка: ${label}`, supports_streaming: true }
  );
  const fileId = uploaded.video?.file_id;
  if (!fileId) throw new Error("telegram_file_id_missing");

  try {
    await bot.api.deleteMessage(adminId, uploaded.message_id);
  } catch (error) {
    console.warn("Could not remove temporary admin upload message", {
      language,
      part,
      error
    });
  }

  if (part === "part1") {
    await setSetting(`trial_video_pending_${language}_part1`, fileId);
    return { activated: false, fileId };
  }

  const part1 = await getSetting(`trial_video_pending_${language}_part1`, "");
  if (!part1) throw new Error("part1_missing");

  const paidChatId = await getPaidChatId();
  let sent1: { message_id: number } | null = null;
  let sent2: { message_id: number } | null = null;

  if (paidChatId) {
    sent1 = await bot.api.sendVideo(paidChatId, part1, {
      supports_streaming: true,
      caption: language === "ru"
        ? "🎬 Бесплатный пробный урок «Клубничка» — часть 1 из 2"
        : "🎬 «Құлпынай» тегін сынақ сабағы — 1-бөлім / 2"
    });
    sent2 = await bot.api.sendVideo(paidChatId, fileId, {
      supports_streaming: true,
      caption: language === "ru"
        ? "🎬 Бесплатный пробный урок «Клубничка» — часть 2 из 2"
        : "🎬 «Құлпынай» тегін сынақ сабағы — 2-бөлім / 2"
    });
  }

  await publishTrialVideoPair(language, part1, fileId);

  if (sent1) {
    await setSetting(`trial_video_message_id_${language}_part1`, String(sent1.message_id));
  }
  if (sent2) {
    await setSetting(`trial_video_message_id_${language}_part2`, String(sent2.message_id));
  }
  await setSetting(`trial_video_message_id_${language}`, "");

  console.info("Trial video activated from secure upload endpoint", {
    language,
    parts: 2
  });

  return { activated: true, fileId };
}

const server = createServer(async (req, res) => {
  const configuredSecret = process.env.TRIAL_UPLOAD_SECRET?.trim() ?? "";
  const providedSecret = String(req.headers["x-trial-upload-secret"] ?? "");
  const internalAuthorized =
    req.method === "POST" &&
    Boolean(configuredSecret) &&
    providedSecret === configuredSecret;

  const trialUploadMatch = req.url?.match(
    /^\/internal\/trial-upload\/(ru|kk)\/(part1|part2)$/
  );

  if (trialUploadMatch) {
    if (!internalAuthorized) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "forbidden" }));
      return;
    }

    try {
      const language = trialUploadMatch[1] as "ru" | "kk";
      const part = trialUploadMatch[2] as "part1" | "part2";
      const bytes = await readRequestBody(req);
      const result = await activateUploadedTrialPart(language, part, bytes);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, language, part, ...result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "upload_failed";
      console.error("Secure trial video upload failed", { error });
      res.writeHead(
        message === "part1_missing" ? 409 : message === "upload_too_large" ? 413 : 500,
        { "content-type": "application/json" }
      );
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

  if (req.url?.startsWith("/instagram/reel-source/")) {
    await handleInstagramReelSource(req, res);
    return;
  }

  if (req.url?.startsWith("/webhooks/instagram")) {
    await handleInstagramWebhook(req, res);
    return;
  }

  if (req.url === "/healthz" || req.url === "/health") {
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
  if (req.url === "/readyz" || req.url === "/ready") {
    try {
      await pool.query("SELECT 1");
      if (!botLockClient || !pollerActive || !stopScheduler) throw new Error("Bot not yet ready");
      if (!await getPaidMainChatId() || !await getPaidChannelId()) throw new Error("Paid targets not configured");
      await checkAccessTargets(bot);
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
  shutdownSignal.abort();
  pollerActive = false;
  stopScheduler?.();
  stopScheduler = null;
  server.close();
  try {
    bot.stop();
  } catch {
    // The replacement instance may still be waiting for the singleton lock.
  }

  if (botLockClient) {
    try {
      await botLockClient.query("SELECT pg_advisory_unlock($1)", [834271]);
    } catch (error) {
      console.warn("Could not explicitly release Telegram poller lock", error);
    } finally {
      botLockClient.release();
      botLockClient = null;
    }
  }

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
    { command: "access", description: "Повторить выдачу доступа / Қолжетімділікті қайта алу" },
    { command: "help", description: "Помощь / Көмек" },
    { command: "privacy", description: "Политика / Құпиялылық" },
    { command: "unsubscribe", description: "Отключить уведомления / Хабарландыруларды өшіру" },
    { command: "subscribe", description: "Включить уведомления / Хабарландыруларды қосу" },
    { command: "myid", description: "Мой Telegram ID / Менің Telegram ID" }
  ]);
} catch (error) {
  console.warn("Could not refresh Telegram commands; continuing startup.", error);
}

await acquireBotInstanceLock();

try { await checkAccessTargets(bot); }
catch (error) {
  const telegram = error as { name?: string; error_code?: number };
  console.error(JSON.stringify({ event: "paid_access_preflight_failed",
    type: telegram.name ?? "Error", code: telegram.error_code ?? null }));
}

stopScheduler = startScheduler(bot);

console.log("Bakieva Chat bot started");
await bot.start({
  drop_pending_updates: false,
  allowed_updates: ["message", "channel_post", "callback_query", "my_chat_member", "chat_member", "chat_join_request"],
  onStart: info => { pollerActive = true; console.log(`Logged in as @${info.username}`); }
});
