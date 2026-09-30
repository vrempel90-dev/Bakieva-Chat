import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeRequestedTrialUpload, completeRequestedTrialUpload,
  REQUESTED_TRIAL_PLAYBACK_KEY } from "./requested_trial_upload.js";

const secret = "playback-test-secret";
function fixture() {
  const sources = Object.fromEntries(["ru", "kk"].flatMap(lang => ["part1", "part2"].map(part =>
    [`trial_video_file_id_${lang}_${part}`, `${lang}-${part}-original`])));
  const initial = { status: "pending", expiresAt: "2026-10-01T18:00:00Z",
    secretSha256: createHash("sha256").update(secret).digest("hex"),
    parts: Object.fromEntries(["ru", "kk"].flatMap(lang => ["part1", "part2"].map(part =>
      [`${lang}_${part}`, { filename: "trial.mp4", bytes: 12, sha256: "checksum",
        playback: { sourceFileId: `${lang}-${part}-original`, width: 720, height: 960, duration: 82 } }]))) };
  let committed = new Map<string, string>(Object.entries({ ...sources, [REQUESTED_TRIAL_PLAYBACK_KEY]: JSON.stringify(initial) }));
  let staged = committed;
  let failUpdate = false;
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql === "BEGIN") staged = new Map(committed);
    if (sql === "COMMIT") committed = new Map(staged);
    if (sql === "ROLLBACK") staged = committed;
    if (sql.startsWith("SELECT key, value")) {
      return { rowCount: 2, rows: (args[0] as string[]).filter(key => staged.has(key))
        .map(key => ({ key, value: staged.get(key) })) };
    }
    if (sql.startsWith("SELECT value")) return { rowCount: staged.has(String(args[0])) ? 1 : 0,
      rows: [{ value: staged.get(String(args[0])) }] };
    if (sql.startsWith("UPDATE")) {
      if (failUpdate) throw new Error("database failure");
      staged.set(String(args[0]), String(args[1]));
    }
    if (sql.startsWith("INSERT")) staged.set(String(args[0]), String(args[1]));
    return { rowCount: 1, rows: [] };
  });
  const release = vi.fn();
  return { database: { query, connect: async () => ({ query, release }) } as unknown as Pick<Pool, "query" | "connect">,
    query, release, state: () => JSON.parse(committed.get(REQUESTED_TRIAL_PLAYBACK_KEY)!),
    value: (key: string) => committed.get(key),
    changeOriginal: () => { committed.set("trial_video_file_id_ru_part1", "replacement-original"); },
    fail: () => { failUpdate = true; } };
}

describe("owner-requested native playback activation", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T18:10:00Z")); });
  afterEach(() => { vi.useRealTimers(); });
  it("scopes playback authorization separately from the completed original upload", async () => {
    const f = fixture();
    expect(await authorizeRequestedTrialUpload(f.database, secret, "ru", "part1")).toBeNull();
    expect(await authorizeRequestedTrialUpload(f.database, secret, "ru", "part1", REQUESTED_TRIAL_PLAYBACK_KEY))
      .toMatchObject({ playback: { sourceFileId: "ru-part1-original" } });
  });
  it("activates both parts together, preserves originals, and revokes the four-part credential", async () => {
    const f = fixture();
    for (const language of ["ru", "kk"] as const) {
      expect(await completeRequestedTrialUpload(f.database, language, "part1", `${language}-video1`, REQUESTED_TRIAL_PLAYBACK_KEY))
        .toEqual({ activated: false });
      expect(f.value(`trial_video_playback_${language}`)).toBeUndefined();
      expect(await completeRequestedTrialUpload(f.database, language, "part2", `${language}-video2`, REQUESTED_TRIAL_PLAYBACK_KEY))
        .toEqual({ activated: true });
      expect(JSON.parse(f.value(`trial_video_playback_${language}`)!)).toEqual({
        sourcePart1: `${language}-part1-original`, sourcePart2: `${language}-part2-original`,
        part1: `${language}-video1`, part2: `${language}-video2`
      });
      expect(f.value(`trial_video_file_id_${language}_part1`)).toBe(`${language}-part1-original`);
      expect(f.value(`trial_video_file_id_${language}_part2`)).toBe(`${language}-part2-original`);
    }
    expect(f.state()).toMatchObject({ status: "done", secretSha256: "" });
    expect(await authorizeRequestedTrialUpload(f.database, secret, "kk", "part2", REQUESTED_TRIAL_PLAYBACK_KEY)).toBeNull();
  });
  it("refuses to activate playback if an original was replaced during upload", async () => {
    const f = fixture();
    f.changeOriginal();
    await expect(completeRequestedTrialUpload(f.database, "ru", "part1", "video1", REQUESTED_TRIAL_PLAYBACK_KEY))
      .rejects.toThrow("trial_originals_changed");
    expect(f.value("trial_video_playback_ru")).toBeUndefined();
    expect(f.state().parts.ru_part1.fileId).toBeUndefined();
  });
  it("rolls playback activation back when completion persistence fails", async () => {
    const f = fixture();
    await completeRequestedTrialUpload(f.database, "ru", "part1", "video1", REQUESTED_TRIAL_PLAYBACK_KEY);
    f.fail();
    await expect(completeRequestedTrialUpload(f.database, "ru", "part2", "video2", REQUESTED_TRIAL_PLAYBACK_KEY))
      .rejects.toThrow("database failure");
    expect(f.value("trial_video_playback_ru")).toBeUndefined();
    expect(f.state().parts.ru_part1.fileId).toBe("video1");
    expect(f.state().parts.ru_part2.fileId).toBeUndefined();
  });
});
