import { spawn } from "node:child_process";
import { readFile, writeFile, stat, unlink } from "node:fs/promises";
import ffmpegPath from "ffmpeg-static";
import pg from "pg";

const sourceUrl = process.env.TRIAL_VIDEO_REPLACE_RU_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!sourceUrl) throw new Error("TRIAL_VIDEO_REPLACE_RU_URL is not set");
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
if (!ffmpegPath) throw new Error("ffmpeg-static binary not found");

const src = "/tmp/bakieva-ru-source.mov";
const out = "/tmp/bakieva-ru-telegram.mp4";

async function download(url, path) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("Downloaded source is empty");
  await writeFile(path, data);
  console.log(`Downloaded source: ${data.length} bytes`);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`)));
  });
}

await download(sourceUrl, src);

await run(ffmpegPath, [
  "-y",
  "-i", src,
  "-vf", "scale=720:1280:flags=lanczos",
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "18",
  "-maxrate", "1850k",
  "-bufsize", "3700k",
  "-pix_fmt", "yuv420p",
  "-profile:v", "high",
  "-level", "4.0",
  "-c:a", "aac",
  "-b:a", "128k",
  "-ar", "48000",
  "-movflags", "+faststart",
  out
]);

const info = await stat(out);
if (info.size > 49 * 1024 * 1024) {
  throw new Error(`Encoded video is too large for Telegram Bot API: ${info.size} bytes`);
}
console.log(`Encoded replacement: ${info.size} bytes`);

const video = await readFile(out);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
});

try {
  await pool.query(
    `INSERT INTO trial_video_assets(language, content, mime_type, telegram_file_id, updated_at)
     VALUES('ru',$1,'video/mp4',NULL,NOW())
     ON CONFLICT(language) DO UPDATE SET
       content=EXCLUDED.content,
       mime_type='video/mp4',
       telegram_file_id=NULL,
       updated_at=NOW()`,
    [video]
  );

  await pool.query(
    `INSERT INTO settings(key,value) VALUES('trial_video_file_id_ru','')
     ON CONFLICT(key) DO UPDATE SET value='', updated_at=NOW()`
  );

  console.log("Russian trial video replaced successfully");
} finally {
  await pool.end();
  await Promise.allSettled([unlink(src), unlink(out)]);
}
