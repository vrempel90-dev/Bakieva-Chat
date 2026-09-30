import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Bot } from "grammy";
import { removeRequestedTrialChatCopies, TRIAL_CHAT_CLEANUP_KEY } from "./trial_chat_cleanup.js";
import { REQUESTED_TRIAL_UPLOAD_KEY } from "./requested_trial_upload.js";

const parts = ["ru_part1", "ru_part2", "kk_part1", "kk_part2"];
function fixture(withMarker = true) {
  const settings = new Map<string,string>();
  if (withMarker) settings.set(TRIAL_CHAT_CLEANUP_KEY,JSON.stringify({ status: "pending", requestedAt: "2026-09-30T17:48:42Z" }));
  settings.set(REQUESTED_TRIAL_UPLOAD_KEY,JSON.stringify({ status: "done", parts: Object.fromEntries(
    parts.map(part => [part,{ fileId: `original-${part}` }])) }));
  parts.forEach((part,index) => {
    settings.set(`trial_video_file_id_${part}`,`original-${part}`);
    settings.set(`trial_video_media_type_${part}`,"document");
    settings.set(`trial_video_message_id_${part}`,String(index + 10));
  });
  let staged = new Map(settings);
  const query = vi.fn(async (sql: string, args: any[] = []) => {
    if (sql === "BEGIN") staged = new Map(settings);
    if (sql === "COMMIT") { settings.clear(); for (const [key,value] of staged) settings.set(key,value); }
    if (sql.startsWith("SELECT value")) {
      const value = staged.get(args[0]);
      return { rowCount: value == null ? 0 : 1, rows: value == null ? [] : [{ value }] };
    }
    if (sql.startsWith("SELECT key,value")) {
      const rows = args[0].filter((key:string) => staged.has(key)).map((key:string) => ({ key,value: staged.get(key) }));
      return { rowCount: rows.length,rows };
    }
    if (sql.startsWith("UPDATE")) staged.set(args[0],String(args[1]));
    return { rowCount: 1, rows: [] };
  });
  const outsideQuery = vi.fn(async (sql:string,args:any[]) => {
    if (sql.startsWith("SELECT key,value")) {
      const rows = args[0].filter((key:string) => settings.has(key)).map((key:string) => ({ key,value: settings.get(key) }));
      return { rowCount: rows.length,rows };
    }
    if (sql.startsWith("DELETE") && settings.get(args[0]) === args[1]) settings.delete(args[0]);
    if (sql.startsWith("UPDATE")) settings.set(args[0],String(args[1]));
    return { rowCount: 1, rows: [] };
  });
  const release = vi.fn();
  const database = { query: outsideQuery,connect: vi.fn(async () => ({ query,release })) } as unknown as Pick<Pool,"connect"|"query">;
  const deleteMessage = vi.fn(async () => true as const);
  const api = { deleteMessage } as unknown as Pick<Bot["api"],"deleteMessage">;
  return { settings,query,outsideQuery,release,database,api,deleteMessage };
}

describe("remove chat copies while keeping the trial originals", () => {
  beforeEach(() => { vi.spyOn(console,"info").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("deletes four chat messages and only their message pointers", async () => {
    const f = fixture();
    expect((await removeRequestedTrialChatCopies(f.database,f.api,-1001))?.status).toBe("done");
    expect(f.deleteMessage.mock.calls).toEqual([[-1001,10],[-1001,11],[-1001,12],[-1001,13]]);
    expect(f.outsideQuery.mock.calls.filter(([sql]) => sql.startsWith("DELETE"))).toHaveLength(4);
    for (const part of parts) {
      expect(f.settings.get(`trial_video_file_id_${part}`)).toBe(`original-${part}`);
      expect(f.settings.get(`trial_video_media_type_${part}`)).toBe("document");
      expect(f.settings.has(`trial_video_message_id_${part}`)).toBe(false);
    }
  });

  it("does not delete any new chat messages on a later startup", async () => {
    const f = fixture();
    await removeRequestedTrialChatCopies(f.database,f.api,-1001);
    f.deleteMessage.mockClear(); f.outsideQuery.mockClear();
    await removeRequestedTrialChatCopies(f.database,f.api,-1001);
    expect(f.deleteMessage).not.toHaveBeenCalled();
    expect(f.outsideQuery).not.toHaveBeenCalled();
  });

  it("retries only an old failed message in its captured chat", async () => {
    const f = fixture();
    f.deleteMessage.mockRejectedValueOnce({ error_code: 500 });
    expect((await removeRequestedTrialChatCopies(f.database,f.api,-1001))?.status).toBe("captured");
    f.deleteMessage.mockClear();
    expect((await removeRequestedTrialChatCopies(f.database,f.api,-1002))?.status).toBe("done");
    expect(f.deleteMessage.mock.calls).toEqual([[-1001,10]]);
  });

  it("refuses deletion if the stored lesson is no longer the four requested originals", async () => {
    const f = fixture();
    f.settings.set("trial_video_file_id_ru_part1","different-original");
    await expect(removeRequestedTrialChatCopies(f.database,f.api,-1001)).rejects.toThrow("originals not confirmed");
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.deleteMessage).not.toHaveBeenCalled();
    expect(f.settings.get("trial_video_file_id_ru_part1")).toBe("different-original");
  });

  it("treats Telegram's already-absent message response as completed", async () => {
    const f = fixture();
    f.deleteMessage.mockRejectedValueOnce({ error_code: 400,description: "Bad Request: message to delete not found" });
    const state = await removeRequestedTrialChatCopies(f.database,f.api,-1001);
    expect(state?.status).toBe("done");
    expect(state?.messages?.[0].status).toBe("absent");
  });

  it("does nothing without the explicit cleanup request", async () => {
    const f = fixture(false);
    expect(await removeRequestedTrialChatCopies(f.database,f.api,-1001)).toBeNull();
    expect(f.deleteMessage).not.toHaveBeenCalled();
  });
});
