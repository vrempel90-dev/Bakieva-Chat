import { InputFile, type Api } from "grammy";
import type { OriginalPart } from "./requested_trial_upload.js";

export async function uploadTrialPlayback(
  api: Pick<Api, "sendVideo" | "deleteMessage">,
  adminId: number,
  bytes: Buffer,
  original: OriginalPart
) {
  if (!adminId || !original.playback || !original.filename.toLowerCase().endsWith(".mp4")) {
    throw new Error("playback_metadata_missing");
  }
  const { width, height, duration } = original.playback;
  const uploaded = await api.sendVideo(adminId, new InputFile(bytes, original.filename), {
    caption: "⬆️ Служебная загрузка пробного урока без перекодирования",
    width, height, duration, supports_streaming: true
  });
  try {
    const video = uploaded.video;
    if (!video?.file_id) throw new Error("telegram_video_missing");
    if (video.file_size !== bytes.length) throw new Error("telegram_file_size_mismatch");
    if (video.width !== width || video.height !== height || Math.abs(video.duration - duration) > 1) {
      throw new Error("telegram_video_metadata_mismatch");
    }
    return { fileId: video.file_id, bytes: video.file_size,
      width: video.width, height: video.height, duration: video.duration };
  } finally {
    // Private staging is never posted to a group. The lesson is served by its file ID.
    await api.deleteMessage(adminId, uploaded.message_id).catch(error => {
      console.warn("Could not remove temporary trial playback upload", { error });
    });
  }
}
