import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { config } from "./config.js";

const GRAPH_ROOT = "https://graph.instagram.com";

function publishingBaseUrl() {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (config.RAILWAY_PUBLIC_DOMAIN) return `https://${config.RAILWAY_PUBLIC_DOMAIN}`;
  return null;
}

export function instagramReelsConfigurationStatus() {
  return {
    accessToken: Boolean(config.INSTAGRAM_ACCESS_TOKEN),
    igUserId: Boolean(config.INSTAGRAM_IG_USER_ID),
    graphVersion: Boolean(config.META_GRAPH_VERSION),
    publicBaseUrl: Boolean(publishingBaseUrl())
  };
}

export function instagramReelsReadyForPublishing() {
  const s = instagramReelsConfigurationStatus();
  return s.accessToken && s.igUserId && s.graphVersion && s.publicBaseUrl;
}

function secureEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signPayload(payload: string) {
  return createHmac("sha256", config.BOT_TOKEN).update(payload).digest("base64url");
}

export function createInstagramReelSourceUrl(
  telegramFileId: string,
  mimeType = "video/mp4",
  ttlSeconds = 60 * 60 * 2
) {
  const baseUrl = publishingBaseUrl();
  if (!baseUrl) throw new Error("PUBLIC_BASE_URL is not configured");

  const payload = Buffer.from(JSON.stringify({
    f: telegramFileId,
    m: mimeType,
    e: Math.floor(Date.now() / 1000) + ttlSeconds
  })).toString("base64url");

  return `${baseUrl}/instagram/reel-source/${payload}.${signPayload(payload)}`;
}

function parseSourceToken(token: string) {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!secureEqual(signPayload(payload), signature)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (
      typeof parsed?.f !== "string" ||
      typeof parsed?.m !== "string" ||
      typeof parsed?.e !== "number" ||
      parsed.e < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return { fileId: parsed.f, mimeType: parsed.m, expiresAt: parsed.e };
  } catch {
    return null;
  }
}

async function telegramFileInfo(fileId: string) {
  const response = await fetch(
    `https://api.telegram.org/bot${config.BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`,
    { signal: AbortSignal.timeout(20_000) }
  );
  const data = await response.json() as any;
  if (!response.ok || !data?.ok || !data?.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return {
    filePath: String(data.result.file_path),
    fileSize: Number(data.result.file_size ?? 0) || null
  };
}

export async function handleInstagramReelSource(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const prefix = "/instagram/reel-source/";
  const token = decodeURIComponent(url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "");
  const source = parseSourceToken(token);
  if (!source) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  try {
    const file = await telegramFileInfo(source.fileId);
    const telegramUrl = `https://api.telegram.org/file/bot${config.BOT_TOKEN}/${file.filePath}`;

    if (req.method === "HEAD") {
      const headers: Record<string, string> = {
        "content-type": source.mimeType || "video/mp4",
        "cache-control": "private, max-age=60"
      };
      if (file.fileSize) headers["content-length"] = String(file.fileSize);
      res.writeHead(200, headers);
      res.end();
      return;
    }

    const upstream = await fetch(telegramUrl, {
      headers: req.headers.range ? { range: String(req.headers.range) } : undefined,
      signal: AbortSignal.timeout(120_000)
    });

    if (!upstream.ok && upstream.status !== 206) {
      const body = await upstream.text();
      throw new Error(`Telegram file HTTP ${upstream.status}: ${body.slice(0, 300)}`);
    }

    const headers: Record<string, string> = {
      "content-type": upstream.headers.get("content-type") || source.mimeType || "video/mp4",
      "cache-control": "private, max-age=60",
      "accept-ranges": upstream.headers.get("accept-ranges") || "bytes"
    };
    for (const name of ["content-length", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }

    res.writeHead(upstream.status, headers);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (error) {
    console.error("Instagram reel source proxy failed", error);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    } else {
      res.end();
    }
  }
}

function requireGraphConfig() {
  if (!config.INSTAGRAM_ACCESS_TOKEN || !config.INSTAGRAM_IG_USER_ID || !config.META_GRAPH_VERSION) {
    throw new Error("Instagram publishing API is not configured");
  }
  return {
    token: config.INSTAGRAM_ACCESS_TOKEN,
    igUserId: config.INSTAGRAM_IG_USER_ID,
    version: config.META_GRAPH_VERSION
  };
}

async function graphPost(path: string, params: Record<string, string>) {
  const { token, version } = requireGraphConfig();
  const response = await fetch(`${GRAPH_ROOT}/${version}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(60_000)
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Instagram API HTTP ${response.status}: ${text.slice(0, 700)}`);
  }
  return data;
}

async function graphGet(path: string, params: Record<string, string>) {
  const { token, version } = requireGraphConfig();
  const url = new URL(`${GRAPH_ROOT}/${version}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Instagram API HTTP ${response.status}: ${text.slice(0, 700)}`);
  }
  return data;
}

export type InstagramReelPublishProgress =
  | { stage: "container_created"; containerId: string }
  | { stage: "processing"; containerId: string; status: string }
  | { stage: "ready"; containerId: string }
  | { stage: "published"; containerId: string; mediaId: string };

export async function publishInstagramReel(input: {
  telegramFileId: string;
  mimeType?: string | null;
  caption?: string;
  onProgress?: (progress: InstagramReelPublishProgress) => Promise<void> | void;
}) {
  const { igUserId } = requireGraphConfig();
  const videoUrl = createInstagramReelSourceUrl(
    input.telegramFileId,
    input.mimeType || "video/mp4"
  );

  const created = await graphPost(`/${encodeURIComponent(igUserId)}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption: (input.caption ?? "").slice(0, 2200),
    share_to_feed: "true"
  });

  const containerId = String(created?.id ?? "").trim();
  if (!containerId) throw new Error("Instagram did not return a reel container id");
  await input.onProgress?.({ stage: "container_created", containerId });

  let lastStatus = "";
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 5_000));
    const status = await graphGet(`/${encodeURIComponent(containerId)}`, {
      fields: "status_code,status"
    });

    const code = String(status?.status_code ?? "").toUpperCase();
    const detail = String(status?.status ?? code || "UNKNOWN");
    if (detail !== lastStatus) {
      lastStatus = detail;
      await input.onProgress?.({ stage: "processing", containerId, status: detail });
    }

    if (code === "FINISHED") {
      ready = true;
      break;
    }
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`Instagram reel processing failed: ${detail}`);
    }
  }

  if (!ready) {
    throw new Error(`Instagram reel processing timeout. Last status: ${lastStatus || "UNKNOWN"}`);
  }

  await input.onProgress?.({ stage: "ready", containerId });
  const published = await graphPost(`/${encodeURIComponent(igUserId)}/media_publish`, {
    creation_id: containerId
  });

  const mediaId = String(published?.id ?? "").trim();
  if (!mediaId) throw new Error("Instagram did not return a published media id");
  await input.onProgress?.({ stage: "published", containerId, mediaId });

  return { containerId, mediaId };
}
