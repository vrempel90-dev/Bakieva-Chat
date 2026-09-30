import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock("./config.js", () => ({ config: {
  BOT_TOKEN: "123:test-token", PUBLIC_BASE_URL: "https://bot.example"
} }));
vi.mock("./db.js", () => db);
import { createInstagramReelSourceUrl, handleInstagramReelSource } from "./instagram_reels.js";

function response() {
  return { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
}
function request(url: string) {
  return { method: "HEAD", url, headers: {} } as IncomingMessage;
}

describe("deleted video source links", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T17:00:00Z"));
    db.getSetting.mockResolvedValue("0");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({
      ok: true, result: { file_path: "videos/new.mp4", file_size: 100 }
    }) })));
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("revokes a previously issued video link before accessing Telegram", async () => {
    const url = createInstagramReelSourceUrl("old-video");
    db.getSetting.mockResolvedValue(String(Date.now()));
    const res = response();
    await handleInstagramReelSource(request(url), res as unknown as ServerResponse);
    expect(res.writeHead).toHaveBeenCalledWith(410, expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("also revokes legacy links that have no issue time", async () => {
    const payload = Buffer.from(JSON.stringify({ f: "legacy-video", m: "video/mp4",
      e: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
    const signature = createHmac("sha256", "123:test-token").update(payload).digest("base64url");
    db.getSetting.mockResolvedValue(String(Date.now()));
    const res = response();
    await handleInstagramReelSource(request(`/instagram/reel-source/${payload}.${signature}`),
      res as unknown as ServerResponse);
    expect(res.writeHead).toHaveBeenCalledWith(410, expect.anything());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows replacement uploads issued after cleanup", async () => {
    db.getSetting.mockResolvedValue(String(Date.now()));
    vi.advanceTimersByTime(1_000);
    const res = response();
    await handleInstagramReelSource(request(createInstagramReelSourceUrl("new-video")),
      res as unknown as ServerResponse);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "content-length": "100" }));
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves existing links when no cleanup has been requested", async () => {
    const res = response();
    await handleInstagramReelSource(request(createInstagramReelSourceUrl("current-video")),
      res as unknown as ServerResponse);
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
  });
});
