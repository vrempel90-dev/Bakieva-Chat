import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import type { Pool } from "pg";
import { runRequestedVideoCleanup, VIDEO_CLEANUP_KEY } from "./video_cleanup.js";

function fixture(marker: unknown = { status: "pending", requestedAt: "2026-09-30T17:00:28Z" }) {
  let committed = marker == null ? null : JSON.stringify(marker);
  let staged = committed;
  let failAt = "";
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (failAt && sql.includes(failAt)) throw new Error("database failure");
    if (sql === "BEGIN") staged = committed;
    if (sql === "COMMIT") committed = staged;
    if (sql.startsWith("SELECT value FROM settings")) {
      return { rowCount: staged == null ? 0 : 1, rows: staged == null ? [] : [{ value: staged }] };
    }
    if (sql.startsWith("SELECT key, value")) return { rowCount: 4, rows: [
      { key: "trial_video_message_id_ru_part1", value: "10" },
      { key: "trial_video_message_id_ru_part2", value: "11" },
      { key: "trial_video_message_id_kk", value: "10" },
      { key: "trial_video_message_id_ru", value: "" }
    ] };
    if (sql.startsWith("DELETE FROM content_posts")) return { rowCount: 3, rows: [] };
    if (sql.startsWith("DELETE FROM trial_video_assets")) return { rowCount: 2, rows: [] };
    if (sql.startsWith("DELETE FROM instagram_reels")) return { rowCount: 1, rows: [] };
    if (sql.startsWith("DELETE FROM settings")) return { rowCount: 12, rows: [] };
    if (sql.includes("AS content_videos")) return { rowCount: 1, rows: [{
      content_videos: "0", trial_assets: "0", reel_uploads: "0", video_settings: "0"
    }] };
    if (sql.startsWith("UPDATE settings SET value=$2")) staged = String(args[1]);
    return { rowCount: 1, rows: [] };
  });
  const release = vi.fn();
  const outsideQuery = vi.fn(async (_sql: string, args: unknown[]) => {
    committed = String(args[1]);
    return { rowCount: 1, rows: [] };
  });
  const connect = vi.fn(async () => ({ query, release }));
  const database = { connect, query: outsideQuery } as unknown as Pick<Pool, "connect" | "query">;
  const deleteMessage = vi.fn(async () => true as const);
  const api = { deleteMessage } as unknown as Pick<Bot["api"], "deleteMessage">;
  return { database, api, query, release, deleteMessage, outsideQuery,
    marker: () => committed == null ? null : JSON.parse(committed), fail: (sql: string) => { failAt = sql; } };
}

describe("explicit one-time video cleanup", () => {
  beforeEach(() => { vi.spyOn(console, "info").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("deletes video storage only, clears legacy links, and verifies no video records remain", async () => {
    const f = fixture();
    const result = await runRequestedVideoCleanup(f.database, f.api, -1001);
    expect(result).toMatchObject({ status: "done", contentVideos: 3, trialAssets: 2,
      reelUploads: 1, videoSettings: 12, unboundMessages: 0 });
    expect(f.query).toHaveBeenCalledWith("DELETE FROM content_posts WHERE kind='video' RETURNING id");
    expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("DELETE"))).toHaveLength(4);
    expect(f.query.mock.calls.some(([sql]) => /DELETE FROM (users|payments|subscriptions|trial_pdf_assets)/.test(sql))).toBe(false);
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("VALUES($1,'')"))
      .map(([,args]) => args?.[0])).toEqual(["trial_url", "trial_url_ru", "trial_url_kk"]);
    expect(f.deleteMessage.mock.calls).toEqual([[-1001, 10], [-1001, 11]]);
    expect(f.marker().status).toBe("done");
    expect(f.query.mock.calls.some(([sql]) => sql.includes("media_video_sources_revoked_before_ms"))).toBe(true);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("never deletes replacement uploads on subsequent startups", async () => {
    const f = fixture();
    await runRequestedVideoCleanup(f.database, f.api, -1001);
    f.query.mockClear();
    f.deleteMessage.mockClear();
    await runRequestedVideoCleanup(f.database, f.api, -1001);
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    expect(f.deleteMessage).not.toHaveBeenCalled();
  });

  it("does nothing without the explicit maintenance request", async () => {
    const f = fixture(null);
    expect(await runRequestedVideoCleanup(f.database, f.api, -1001)).toBeNull();
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    expect(f.deleteMessage).not.toHaveBeenCalled();
  });

  it("rolls back the database cleanup if any storage deletion fails", async () => {
    const f = fixture();
    f.fail("DELETE FROM trial_video_assets");
    await expect(runRequestedVideoCleanup(f.database, f.api, -1001)).rejects.toThrow("database failure");
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.marker().status).toBe("pending");
    expect(f.deleteMessage).not.toHaveBeenCalled();
  });

  it("records Telegram's deletion refusal while completing the database cleanup", async () => {
    const f = fixture();
    f.deleteMessage.mockRejectedValue({ error_code: 400, description: "message can't be deleted" });
    const result = await runRequestedVideoCleanup(f.database, f.api, -1001);
    expect(result?.status).toBe("done");
    expect(result?.messages?.every(message => message.status === "unavailable" && message.errorCode === 400)).toBe(true);
  });

  it("retries a transient Telegram failure without clearing newly uploaded videos", async () => {
    const f = fixture();
    f.deleteMessage.mockRejectedValueOnce({ error_code: 500 });
    const first = await runRequestedVideoCleanup(f.database, f.api, -1001);
    expect(first?.status).toBe("database_deleted");
    f.query.mockClear();
    f.deleteMessage.mockClear();
    const second = await runRequestedVideoCleanup(f.database, f.api, -1001);
    expect(second?.status).toBe("done");
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("DELETE"))).toBe(false);
    expect(f.deleteMessage.mock.calls).toEqual([[-1001, 10]]);
  });

  it("does not guess a destination for stored message IDs when their chat is unbound", async () => {
    const f = fixture();
    const result = await runRequestedVideoCleanup(f.database, f.api, 0);
    expect(result).toMatchObject({ status: "done", unboundMessages: 2, messages: [] });
    expect(f.deleteMessage).not.toHaveBeenCalled();
  });
});
