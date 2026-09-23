import type { PoolClient } from "pg";
import { createServer, type IncomingMessage } from "node:http";
import { InputFile } from "grammy";
import { config } from "./config.js";
import {
  clearTrialVideoAsset,
  getPaidChatId,
  getSetting,
  getTrialPdfAsset,
  getTrialVideoAsset,
  migrate,
  pool,
  setSetting,
  setTrialVideoTelegramFileId,
  upsertTrialPdfContent,
  upsertTrialVideoContent
} from "./db.js";
import { createBot } from "./bot.js";
import { startScheduler } from "./scheduler.js";
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
let botLockClient: PoolClient | null = null;

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireBotInstanceLock() {
  while (true) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [834271]
      );
      if (result.rows[0]?.locked === true) {
        botLockClient = client;
        console.log("Telegram poller lock acquired");
        return;
      }
    } catch (error) {
      client.release();
      throw error;
    }

    client.release();
    console.log("Another Telegram poller is active; waiting for lock");
    await sleep(2000);
  }
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
  const previousIds = [
    Number(await getSetting(`trial_video_message_id_${language}`, "0")),
    Number(await getSetting(`trial_video_message_id_${language}_part1`, "0")),
    Number(await getSetting(`trial_video_message_id_${language}_part2`, "0"))
  ].filter(id => Number.isSafeInteger(id) && id > 0);

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

  await Promise.all([
    setSetting(`trial_video_file_id_${language}_part1`, part1),
    setSetting(`trial_video_file_id_${language}_part2`, fileId),
    setSetting(`trial_video_file_id_${language}`, ""),
    setSetting(`trial_video_pending_${language}_part1`, ""),
    clearTrialVideoAsset(language)
  ]);

  if (sent1) {
    await setSetting(`trial_video_message_id_${language}_part1`, String(sent1.message_id));
  }
  if (sent2) {
    await setSetting(`trial_video_message_id_${language}_part2`, String(sent2.message_id));
  }
  await setSetting(`trial_video_message_id_${language}`, "");

  if (paidChatId) {
    for (const messageId of previousIds) {
      if (messageId === sent1?.message_id || messageId === sent2?.message_id) continue;
      try {
        await bot.api.deleteMessage(paidChatId, messageId);
      } catch (error) {
        console.warn("Could not delete previous trial video message", {
          language,
          paidChatId,
          messageId,
          error
        });
      }
    }
  }

  console.info("Trial video activated from secure upload endpoint", {
    language,
    parts: 2
  });

  return { activated: true, fileId };
}

async function fetchTemporaryTrialVideo(url: string, label: string) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) {
    throw new Error(`${label} download failed: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength && contentLength > 49 * 1024 * 1024) {
    throw new Error(`${label} exceeds 49 MB`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 49 * 1024 * 1024) {
    throw new Error(`${label} invalid size: ${bytes.length}`);
  }
  return bytes;
}

async function importTrialVideosFromTemporaryUrls() {
  const batchId = (process.env.TRIAL_IMPORT_BATCH_ID ?? "").trim();
  if (!batchId) throw new Error("TRIAL_IMPORT_BATCH_ID is required");

  const markerKey = `trial_import_batch_${batchId}_completed`;
  if ((await getSetting(markerKey, "")).trim()) {
    console.info("Trial import batch already completed", { batchId });
    return;
  }

  const urls = {
    ruPart1: (process.env.TRIAL_IMPORT_RU_PART1_URL ?? "").trim(),
    ruPart2: (process.env.TRIAL_IMPORT_RU_PART2_URL ?? "").trim(),
    kkPart1: (process.env.TRIAL_IMPORT_KK_PART1_URL ?? "").trim(),
    kkPart2: (process.env.TRIAL_IMPORT_KK_PART2_URL ?? "").trim()
  };

  if (Object.values(urls).some(url => !url)) {
    throw new Error("All four temporary trial video URLs are required");
  }

  const ruPart1 = await fetchTemporaryTrialVideo(urls.ruPart1, "ru part1");
  await activateUploadedTrialPart("ru", "part1", ruPart1);
  const ruPart2 = await fetchTemporaryTrialVideo(urls.ruPart2, "ru part2");
  await activateUploadedTrialPart("ru", "part2", ruPart2);

  const kkPart1 = await fetchTemporaryTrialVideo(urls.kkPart1, "kk part1");
  await activateUploadedTrialPart("kk", "part1", kkPart1);
  const kkPart2 = await fetchTemporaryTrialVideo(urls.kkPart2, "kk part2");
  await activateUploadedTrialPart("kk", "part2", kkPart2);

  await setSetting(markerKey, new Date().toISOString());
  console.info("Temporary trial video import completed", {
    batchId,
    ruParts: 2,
    kkParts: 2
  });
}

async function purgeAdminUploadedVideos() {
  const paidChatId = await getPaidChatId();
  const messageKeys = [
    "trial_video_message_id_ru",
    "trial_video_message_id_ru_part1",
    "trial_video_message_id_ru_part2",
    "trial_video_message_id_kk",
    "trial_video_message_id_kk_part1",
    "trial_video_message_id_kk_part2"
  ];

  const messageIds = [
    ...new Set(
      (
        await Promise.all(
          messageKeys.map(async key => Number(await getSetting(key, "0")))
        )
      ).filter(id => Number.isSafeInteger(id) && id > 0)
    )
  ];

  let deletedChatMessages = 0;
  if (paidChatId) {
    for (const messageId of messageIds) {
      try {
        await bot.api.deleteMessage(paidChatId, messageId);
        deletedChatMessages++;
      } catch (error) {
        console.warn("Could not delete old trial video message", {
          paidChatId,
          messageId,
          error
        });
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const content = await client.query(
      "DELETE FROM content_posts WHERE kind='video'"
    );
    const assets = await client.query(
      "DELETE FROM trial_video_assets"
    );
    const settings = await client.query(
      `DELETE FROM settings
       WHERE key LIKE 'trial_video_%'
          OR key IN ('trial_url','trial_url_ru','trial_url_kk')`
    );

    await client.query("COMMIT");

    console.info("Admin-uploaded bot videos purged", {
      contentRows: content.rowCount ?? 0,
      trialAssets: assets.rowCount ?? 0,
      settingsRows: settings.rowCount ?? 0,
      deletedChatMessages
    });

    return {
      contentRows: content.rowCount ?? 0,
      trialAssets: assets.rowCount ?? 0,
      settingsRows: settings.rowCount ?? 0,
      deletedChatMessages
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const server = createServer(async (req, res) => {
  const configuredSecret = process.env.TRIAL_UPLOAD_SECRET?.trim() ?? "";
  const providedSecret = String(req.headers["x-trial-upload-secret"] ?? "");
  const internalAuthorized =
    req.method === "POST" &&
    Boolean(configuredSecret) &&
    providedSecret === configuredSecret;

  if (req.url === "/internal/trial-cleanup") {
    if (!internalAuthorized) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "forbidden" }));
      return;
    }

    try {
      const result = await purgeAdminUploadedVideos();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "cleanup_failed";
      console.error("Trial video cleanup failed", { error });
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: message }));
    }
    return;
  }

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
    { command: "unsubscribe", description: "Отключить уведомления / Хабарландыруларды өшіру" },
    { command: "subscribe", description: "Включить уведомления / Хабарландыруларды қосу" },
    { command: "myid", description: "Мой Telegram ID / Менің Telegram ID" }
  ]);
} catch (error) {
  console.warn("Could not refresh Telegram commands; continuing startup.", error);
}

await acquireBotInstanceLock();

if (process.env.PURGE_ADMIN_VIDEOS_ON_START === "1") {
  const markerKey = "admin_video_purge_2026_09_23_completed";
  const alreadyPurged = (await getSetting(markerKey, "")).trim();
  if (!alreadyPurged) {
    const result = await purgeAdminUploadedVideos();
    await setSetting(markerKey, new Date().toISOString());
    console.info("One-time admin video purge completed", result);
  } else {
    console.info("One-time admin video purge already completed");
  }
}

if (process.env.IMPORT_TRIAL_VIDEOS_ON_START === "1") {
  await importTrialVideosFromTemporaryUrls();
}

startScheduler(bot);

console.log("Bakieva Chat bot started");
await bot.start({
  drop_pending_updates: false,
  onStart: info => console.log(`Logged in as @${info.username}`)
});
