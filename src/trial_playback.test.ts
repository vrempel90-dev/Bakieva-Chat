import type { Api } from "grammy";
import { InputFile } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { uploadTrialPlayback } from "./trial_playback.js";

const bytes = Buffer.from("unchanged encoded streams");
const original = { filename: "trial.mp4", bytes: bytes.length, sha256: "unused",
  playback: { sourceFileId: "original-document", width: 720, height: 960, duration: 82 } };
function fixture(video: Record<string, unknown> | null = {
  file_id: "native-video", file_size: bytes.length, width: 720, height: 960, duration: 82
}) {
  const sendVideo = vi.fn().mockResolvedValue({ message_id: 25, video });
  const deleteMessage = vi.fn().mockResolvedValue(true);
  return { sendVideo, deleteMessage, api: { sendVideo, deleteMessage } as unknown as Pick<Api, "sendVideo" | "deleteMessage"> };
}
describe("private native trial playback upload", () => {
  it("uploads the exact provided MP4 bytes and removes only its private staging message", async () => {
    const f = fixture();
    expect(await uploadTrialPlayback(f.api, 123, bytes, original)).toEqual({
      fileId: "native-video", bytes: bytes.length, width: 720, height: 960, duration: 82
    });
    expect(f.sendVideo).toHaveBeenCalledOnce();
    const [destination, input, options] = f.sendVideo.mock.calls[0];
    expect(destination).toBe(123);
    expect(input).toBeInstanceOf(InputFile);
    expect(input.fileData).toBe(bytes);
    expect(options).toMatchObject({ width: 720, height: 960, duration: 82, supports_streaming: true });
    expect(f.deleteMessage).toHaveBeenCalledWith(123, 25);
  });
  it.each([
    [null, "telegram_video_missing"],
    [{ file_id: "native-video", file_size: bytes.length - 1 }, "telegram_file_size_mismatch"],
    [{ file_id: "native-video", file_size: bytes.length, width: 360, height: 480, duration: 82 },
      "telegram_video_metadata_mismatch"]
  ])("rejects unusable or changed Telegram media and still removes staging: %j", async (video, error) => {
    const f = fixture(video as Record<string, unknown> | null);
    await expect(uploadTrialPlayback(f.api, 123, bytes, original)).rejects.toThrow(String(error));
    expect(f.deleteMessage).toHaveBeenCalledWith(123, 25);
  });
});
