import { beforeEach, describe, expect, it, vi } from "vitest";
import { InputFile } from "grammy";
import type { Update } from "grammy/types";

const db = vi.hoisted(() => ({
  ensureUser: vi.fn(),
  getPaidChatId: vi.fn(),
  getUserLanguage: vi.fn(),
  getTrialVideoPair: vi.fn(),
  getTrialVideoAsset: vi.fn(),
  publishTrialVideoPair: vi.fn(),
  setSetting: vi.fn(),
  setTrialVideoTelegramFileId: vi.fn()
}));
vi.mock("./config.js", () => ({ config: {
  BOT_TOKEN: "123:test-token",
  DATABASE_URL: "postgres://localhost/test",
  adminIds: new Set([123]),
  paidChatId: 0,
  paidChannelId: -1001,
  paidMainChatId: 0,
  talkChatId: 0
}, CONSENT_VERSION: "test" }));
vi.mock("./db.js", async importOriginal => ({
  ...await importOriginal<typeof import("./db.js")>(),
  ...db
}));
import { createBot } from "./bot.js";

const user = { id: 123, is_bot: false, first_name: "Admin" };
const chat = { id: 123, type: "private" as const, first_name: "Admin" };
let updateId = 0;

function fixture() {
  const bot = createBot();
  bot.botInfo = { id: 42, is_bot: true, first_name: "Test", username: "test_bot",
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: {
      message_id: calls.length, date: 0, chat,
      document: { file_id: "cached-original", file_unique_id: "unique-original" }
    } } as any;
  });
  const callback = (data: string) => bot.handleUpdate({
    update_id: ++updateId,
    callback_query: { id: String(updateId), from: user, chat_instance: "test", data,
      message: { message_id: 1, date: 0, chat, text: "Menu" } }
  });
  const document = (id: string, size = 300_000_000) => bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, chat, from: user,
      document: { file_id: id, file_unique_id: `unique-${id}`, file_name: "original.MOV",
        mime_type: "video/quicktime", file_size: size } }
  });
  const video = () => bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, chat, from: user,
      video: { file_id: "gallery-video", file_unique_id: "gallery-unique",
        width: 720, height: 1280, duration: 10 } }
  } satisfies Update);
  const command = (text: string, userId: number) => bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, chat: { ...chat, id: userId },
      from: { ...user, id: userId }, text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }] }
  });
  return { bot, calls, callback, document, video, command };
}

describe("original trial video upload and delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.ensureUser.mockResolvedValue(undefined);
    db.getPaidChatId.mockResolvedValue(0);
    db.getUserLanguage.mockResolvedValue("ru");
    db.getTrialVideoPair.mockResolvedValue(null);
    db.getTrialVideoAsset.mockResolvedValue(null);
    db.publishTrialVideoPair.mockResolvedValue(undefined);
  });

  it("explains missing admin access without granting permissions", async () => {
    const f = fixture();
    await f.command("/admin", 456);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "sendMessage", payload: {
      chat_id: 456, text: expect.stringContaining("Ваш Telegram ID: 456")
    } });
    expect(f.calls[0].payload.reply_markup).toBeUndefined();
    expect(db.publishTrialVideoPair).not.toHaveBeenCalled();
  });

  for (const language of ["ru", "kk"] as const) {
    it(`rejects gallery video at either ${language} step, then activates large original files`, async () => {
      const f = fixture();
      db.getPaidChatId.mockResolvedValue(-1001);
      await f.callback(`panel:trial:${language}`);
      await f.video();
      expect(db.publishTrialVideoPair).not.toHaveBeenCalled();
      await f.document("original-part1");
      expect(db.publishTrialVideoPair).not.toHaveBeenCalled();
      await f.video();
      expect(db.publishTrialVideoPair).not.toHaveBeenCalled();
      await f.document("original-part2");
      expect(db.publishTrialVideoPair).toHaveBeenCalledExactlyOnceWith(
        language, "original-part1", "original-part2", { part1: "document", part2: "document" }
      );
      expect(f.calls.some(call => ["sendVideo", "getFile"].includes(call.method))).toBe(false);
      expect(f.calls.filter(call => ["sendDocument", "sendVideo"].includes(call.method) &&
        call.payload.chat_id === -1001)).toEqual([]);

      db.getUserLanguage.mockResolvedValue(language);
      db.getTrialVideoPair.mockResolvedValue({
        part1: "original-part1", part2: "original-part2",
        part1MediaType: "document", part2MediaType: "document"
      });
      await f.callback("menu:trial");
      const sent = f.calls.filter(call => call.method === "sendDocument");
      expect(sent.map(call => call.payload.document)).toEqual(["original-part1", "original-part2"]);
      expect(sent.every(call => call.payload.protect_content === true)).toBe(true);
      expect(sent[1].payload.reply_markup).toBeDefined();
    });
  }

  it("allows retrying the second file after an activation failure", async () => {
    const f = fixture();
    await f.callback("panel:trial:ru");
    await f.document("part1");
    db.publishTrialVideoPair.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.document("part2")).rejects.toThrow("database unavailable");
    await f.document("part2-retry");
    expect(db.publishTrialVideoPair).toHaveBeenLastCalledWith(
      "ru", "part1", "part2-retry", { part1: "document", part2: "document" }
    );
  });

  it("uploads single stored bytes as a document and reuses its document ID on the next view", async () => {
    const original = Buffer.from([0, 255, 42, 17, 99, 128, 64]);
    db.getTrialVideoAsset.mockResolvedValue({
      content: original, telegramFileId: null, telegramMediaType: "document",
      mimeType: "video/quicktime", filename: "original.mov"
    });
    const f = fixture();
    await f.callback("menu:trial");
    const sent = f.calls.find(call => call.method === "sendDocument")!;
    const input = sent.payload.document as InputFile;
    expect(input).toBeInstanceOf(InputFile);
    expect(input.filename).toBe("original.mov");
    expect(await input.toRaw()).toEqual(original);
    expect(sent.payload.disable_content_type_detection).toBe(true);
    expect(db.setTrialVideoTelegramFileId).toHaveBeenCalledWith("ru", "cached-original", "document");
    expect(db.setSetting).toHaveBeenCalledWith("trial_video_media_type_ru", "document");

    db.getTrialVideoAsset.mockResolvedValue({
      content: original, telegramFileId: "cached-original", telegramMediaType: "document",
      mimeType: "video/quicktime", filename: "original.mov"
    });
    await f.callback("menu:trial");
    expect(f.calls.filter(call => call.method === "sendDocument").at(-1)?.payload.document)
      .toBe("cached-original");
    expect(f.calls.some(call => call.method === "sendVideo")).toBe(false);
  });

  it("keeps existing video file IDs compatible with Telegram's original media type", async () => {
    db.getTrialVideoAsset.mockResolvedValue({
      content: null, telegramFileId: "legacy-video", telegramMediaType: "video",
      mimeType: "video/mp4", filename: "trial.mp4"
    });
    const f = fixture();
    await f.callback("menu:trial");
    expect(f.calls.find(call => call.method === "sendVideo")?.payload.video).toBe("legacy-video");
    expect(f.calls.some(call => call.method === "sendDocument")).toBe(false);
  });
});
