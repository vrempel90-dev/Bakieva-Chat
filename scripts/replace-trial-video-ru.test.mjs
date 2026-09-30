import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { downloadOriginalTrialVideo, MAX_ORIGINAL_BYTES, replaceRussianTrialVideo } from "./replace-trial-video-ru.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function database() {
  const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
  return { client, pool: { connect: vi.fn(async () => client) } };
}

describe("original RU replacement", () => {
  it("preserves the full original bytes and MOV filename from download to storage", async () => {
    const bytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 113, 116, 255, 128, 42]);
    const fetchOriginal = vi.fn(async () => new Response(bytes, {
      headers: { "content-type": "video/quicktime", "content-length": String(bytes.length) }
    }));
    const original = await downloadOriginalTrialVideo("https://example.test/original.MOV", fetchOriginal);
    expect(hash(original.bytes)).toBe(hash(bytes));
    expect(original.filename).toBe("original.MOV");
    expect(original.mimeType).toBe("video/quicktime");
    const d = database();
    await replaceRussianTrialVideo(d.pool, original);
    const insert = d.client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO trial_video_assets"));
    expect(hash(insert[1][0])).toBe(hash(bytes));
    expect(insert[1].slice(1)).toEqual(["video/quicktime", "original.MOV"]);
    expect(d.client.query.mock.calls[0]).toEqual(["BEGIN"]);
    expect(d.client.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
    const cleared = d.client.query.mock.calls.filter(([sql]) => sql.includes("VALUES($1,'')"))
      .map(([,args]) => args[0]);
    expect(cleared).toEqual(expect.arrayContaining(["trial_video_file_id_ru_part1", "trial_video_file_id_ru_part2"]));
    expect(d.client.release).toHaveBeenCalledOnce();
  });

  it("refuses an oversized original with instructions to use File, without compressing", async () => {
    const fetchOriginal = vi.fn(async () => new Response("original", {
      headers: { "content-length": String(MAX_ORIGINAL_BYTES + 1) }
    }));
    await expect(downloadOriginalTrialVideo("https://example.test/original.mp4", fetchOriginal))
      .rejects.toThrow("Upload the original through /admin as File/Document");
    const d = database();
    await expect(replaceRussianTrialVideo(d.pool, {
      bytes: Buffer.alloc(MAX_ORIGINAL_BYTES + 1), filename: "original.mp4", mimeType: "video/mp4"
    })).rejects.toThrow("do not compress");
    expect(d.pool.connect).not.toHaveBeenCalled();
  });

  it("enforces the limit on streamed bytes even without a Content-Length header", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ORIGINAL_BYTES + 1));
      }, cancel
    });
    await expect(downloadOriginalTrialVideo("https://example.test/original.mp4",
      async () => new Response(body))).rejects.toThrow("direct upload limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rolls back the single replacement and old pair pointers together on failure", async () => {
    const d = database();
    d.client.query.mockImplementation(async (sql, args) => {
      if (args?.[0] === "trial_video_file_id_ru_part2") throw new Error("database unavailable");
      return { rows: [] };
    });
    await expect(replaceRussianTrialVideo(d.pool, {
      bytes: Buffer.from("original"), filename: "original.mp4", mimeType: "video/mp4"
    })).rejects.toThrow("database unavailable");
    expect(d.client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(d.client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(d.client.release).toHaveBeenCalledOnce();
  });
});
