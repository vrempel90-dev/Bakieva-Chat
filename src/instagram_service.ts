import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import {
  claimInstagramComment,
  listCandidateInstagramAutomations,
  markInstagramCommentFailed,
  markInstagramCommentSent
} from "./instagram_db.js";
import {
  extractInstagramCommentEvents,
  matchesInstagramRule,
  type InstagramCommentEvent
} from "./instagram_rules.js";

export function instagramConfigurationStatus() {
  return {
    appId: Boolean(config.META_APP_ID),
    appSecret: Boolean(config.META_APP_SECRET),
    verifyToken: Boolean(config.META_WEBHOOK_VERIFY_TOKEN),
    accessToken: Boolean(config.INSTAGRAM_ACCESS_TOKEN),
    igUserId: Boolean(config.INSTAGRAM_IG_USER_ID),
    graphVersion: Boolean(config.META_GRAPH_VERSION)
  };
}

export function instagramReadyForDelivery() {
  return Boolean(
    config.INSTAGRAM_ACCESS_TOKEN &&
    config.INSTAGRAM_IG_USER_ID &&
    config.META_GRAPH_VERSION
  );
}

function secureEqual(expected: string, received: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyInstagramWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined) {
  if (!config.META_APP_SECRET || !signatureHeader?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", config.META_APP_SECRET)
    .update(rawBody)
    .digest("hex");
  return secureEqual(expected, signatureHeader);
}

async function sendPrivateReply(event: InstagramCommentEvent, text: string) {
  if (!config.INSTAGRAM_ACCESS_TOKEN || !config.INSTAGRAM_IG_USER_ID || !config.META_GRAPH_VERSION) {
    throw new Error("Instagram API is not configured");
  }

  const url = `https://graph.instagram.com/${config.META_GRAPH_VERSION}/${encodeURIComponent(
    config.INSTAGRAM_IG_USER_ID
  )}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.INSTAGRAM_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      recipient: { comment_id: event.commentId },
      message: { text: text.slice(0, 1000) }
    })
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Instagram API HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  try {
    const data = JSON.parse(bodyText);
    return typeof data?.message_id === "string" ? data.message_id : null;
  } catch {
    return null;
  }
}

async function processComment(event: InstagramCommentEvent) {
  const rules = await listCandidateInstagramAutomations(event.mediaId);
  const rule = rules.find(candidate =>
    matchesInstagramRule(candidate.matchMode, candidate.keywords, event.text)
  );
  if (!rule) return;

  const claimed = await claimInstagramComment(event.commentId, event.mediaId, rule.id);
  if (!claimed) return;

  try {
    const messageId = await sendPrivateReply(event, rule.dmText);
    await markInstagramCommentSent(event.commentId, messageId);
    console.log("Instagram comment auto-DM sent", {
      commentId: event.commentId,
      mediaId: event.mediaId,
      automationId: rule.id,
      username: event.username
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markInstagramCommentFailed(event.commentId, message);
    console.error("Instagram comment auto-DM failed", {
      commentId: event.commentId,
      mediaId: event.mediaId,
      automationId: rule.id,
      error: message
    });
  }
}

async function readBody(req: IncomingMessage, maxBytes = 1_000_000) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error("Webhook payload too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function handleInstagramWebhook(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";

    if (
      mode === "subscribe" &&
      config.META_WEBHOOK_VERIFY_TOKEN &&
      token === config.META_WEBHOOK_VERIFY_TOKEN
    ) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(challenge);
      return;
    }

    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "GET, POST" });
    res.end();
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch {
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  const signature = Array.isArray(req.headers["x-hub-signature-256"])
    ? req.headers["x-hub-signature-256"][0]
    : req.headers["x-hub-signature-256"];

  if (!verifyInstagramWebhookSignature(rawBody, signature)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));

  for (const event of extractInstagramCommentEvents(payload)) {
    void processComment(event).catch(error => {
      console.error("Unhandled Instagram comment processing error", error);
    });
  }
}
