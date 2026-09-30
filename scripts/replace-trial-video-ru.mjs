import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Conservative headroom for Telegram's 50 MB multipart upload limit.
export const MAX_ORIGINAL_BYTES = 49_000_000;
const tooLargeMessage = "Original video exceeds the direct upload limit. Upload the original through /admin as File/Document; do not compress it.";

export async function downloadOriginalTrialVideo(url, fetchOriginal = fetch) {
  const response = await fetchOriginal(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") ?? "0");
  if (declaredSize > MAX_ORIGINAL_BYTES) {
    await response.body?.cancel();
    throw new Error(tooLargeMessage);
  }
  if (!response.body) throw new Error("Downloaded source is empty");

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ORIGINAL_BYTES) {
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new Error("Downloaded source is empty");

  const sourceName = basename(decodeURIComponent(new URL(url).pathname));
  const filename = /\.(mp4|mov|mkv|webm)$/i.test(sourceName)
    ? sourceName.slice(-128)
    : "trial_ru.mp4";
  const mimeByExtension = {
    mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", mp4: "video/mp4"
  };
  const contentType = response.headers.get("content-type")?.split(";")[0].trim();
  const mimeType = contentType?.startsWith("video/")
    ? contentType
    : mimeByExtension[filename.split(".").at(-1).toLowerCase()];
  return { bytes: Buffer.concat(chunks, size), filename, mimeType };
}

export async function replaceRussianTrialVideo(pool, original) {
  if (!original.bytes.length) throw new Error("Downloaded source is empty");
  if (original.bytes.length > MAX_ORIGINAL_BYTES) throw new Error(tooLargeMessage);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO trial_video_assets(language, content, mime_type, filename, telegram_media_type, telegram_file_id, updated_at)
       VALUES('ru',$1,$2,$3,'document',NULL,NOW())
       ON CONFLICT(language) DO UPDATE SET
         content=EXCLUDED.content,
         mime_type=EXCLUDED.mime_type,
         filename=EXCLUDED.filename,
         telegram_media_type='document',
         telegram_file_id=NULL,
         updated_at=NOW()`,
      [original.bytes, original.mimeType, original.filename]
    );
    // The bot prefers a complete pair. Clear its pointers in this same transaction
    // so the newly replaced single original cannot be hidden by an older pair.
    for (const key of [
      "trial_video_file_id_ru", "trial_video_file_id_ru_part1", "trial_video_file_id_ru_part2",
      "trial_video_media_type_ru_part1", "trial_video_media_type_ru_part2",
      "trial_video_pending_ru_part1", "trial_video_pending_ru_part1_media_type"
    ]) {
      await client.query(
        `INSERT INTO settings(key,value) VALUES($1,'')
         ON CONFLICT(key) DO UPDATE SET value='', updated_at=NOW()`,
        [key]
      );
    }
    await client.query(
      `INSERT INTO settings(key,value) VALUES('trial_video_media_type_ru','document')
       ON CONFLICT(key) DO UPDATE SET value='document', updated_at=NOW()`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const sourceUrl = process.env.TRIAL_VIDEO_REPLACE_RU_URL;
  const databaseUrl = process.env.DATABASE_URL;
  if (!sourceUrl) throw new Error("TRIAL_VIDEO_REPLACE_RU_URL is not set");
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const original = await downloadOriginalTrialVideo(sourceUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
  });
  try {
    await replaceRussianTrialVideo(pool, original);
    console.log(`Russian trial video replaced with original file: ${original.bytes.length} bytes`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
