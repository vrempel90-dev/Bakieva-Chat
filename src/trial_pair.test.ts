import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const committed = new Map<string, string>();
  let failNextPart2 = false;
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith("SELECT key, value FROM settings")) {
      const keys = args[0] as string[];
      return { rows: keys.filter(key => committed.has(key)).map(key => ({ key, value: committed.get(key) })) };
    }
    return { rows: [] };
  });
  const connect = vi.fn(async () => {
    const staged = new Map<string, string>();
    return { release: vi.fn(), query: async (sql: string, args: unknown[] = []) => {
      if (sql.startsWith("INSERT INTO settings")) {
        if (failNextPart2 && String(args[0]).endsWith("part2")) {
          failNextPart2 = false;
          throw new Error("database write failure");
        }
        staged.set(String(args[0]), String(args[1]));
      }
      if (sql === "COMMIT") for (const [key, value] of staged) committed.set(key, value);
      return { rows: [] };
    } };
  });
  return { committed, query, connect, fail: () => { failNextPart2 = true; } };
});
vi.mock("pg", () => ({ default: { Pool: class { query = database.query; connect = database.connect; } } }));
vi.mock("./config.js", () => ({ config: { DATABASE_URL: "postgres://localhost/test" } }));
import { getTrialVideoPair, publishTrialVideoPair } from "./db.js";

describe("two-part trial version", () => {
  beforeEach(() => { database.committed.clear(); database.query.mockClear(); });
  for (const language of ["ru", "kk"] as const) {
    it(`switches both ${language} parts together and preserves the prior pair on failure`, async () => {
      await publishTrialVideoPair(language, "old1", "old2");
      database.fail();
      await expect(publishTrialVideoPair(language, "new1", "new2")).rejects.toThrow("database write failure");
      expect(await getTrialVideoPair(language)).toEqual({ part1: "old1", part2: "old2" });
      await publishTrialVideoPair(language, "new1", "new2");
      expect(await getTrialVideoPair(language)).toEqual({ part1: "new1", part2: "new2" });
      expect(database.query).toHaveBeenCalledWith("SELECT key, value FROM settings WHERE key=ANY($1::text[])",
        [[`trial_video_file_id_${language}_part1`, `trial_video_file_id_${language}_part2`]]);
    });
  }
});
