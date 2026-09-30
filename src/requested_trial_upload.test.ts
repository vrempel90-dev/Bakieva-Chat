import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeRequestedTrialUpload, completeRequestedTrialUpload, verifyRequestedTrialBytes } from "./requested_trial_upload.js";

const secret = "test-maintenance-secret";
const bytes = Buffer.from("original video bytes");
const original = { filename: "original.MOV", bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex") };
function fixture(overrides: Record<string, unknown> = {}) {
  let committed = JSON.stringify({ status: "pending", expiresAt: "2026-10-01T17:00:28Z",
    secretSha256: createHash("sha256").update(secret).digest("hex"),
    parts: Object.fromEntries(["ru_part1", "ru_part2", "kk_part1", "kk_part2"]
      .map(key => [key, { ...original }])), ...overrides });
  let staged = committed;
  let failUpdate = false;
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql === "BEGIN") staged = committed;
    if (sql === "COMMIT") committed = staged;
    if (sql.startsWith("SELECT")) return { rowCount: 1, rows: [{ value: staged }] };
    if (sql.startsWith("UPDATE")) {
      if (failUpdate) throw new Error("database failure");
      staged = String(args[1]);
    }
    return { rowCount: 1, rows: [] };
  });
  const release = vi.fn();
  const database = { query, connect: vi.fn(async () => ({ query, release })) } as unknown as Pick<Pool, "query" | "connect">;
  return { database, query, release, state: () => JSON.parse(committed),
    fail: () => { failUpdate = true; } };
}

describe("owner-requested original trial uploads", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-30T17:30:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("authorizes only the scoped secret and requested original part", async () => {
    const f = fixture();
    expect(await authorizeRequestedTrialUpload(f.database, secret, "ru", "part1")).toEqual(original);
    expect(await authorizeRequestedTrialUpload(f.database, "wrong-secret", "ru", "part1")).toBeNull();
    expect(await authorizeRequestedTrialUpload(f.database, "", "ru", "part1")).toBeNull();
  });

  it.each([{ status: "done" }, { expiresAt: "2026-09-29T00:00:00Z" }, { expiresAt: "invalid" }])
    ("rejects a completed or expired request: %j", async overrides => {
      const f = fixture(overrides);
      expect(await authorizeRequestedTrialUpload(f.database, secret, "ru", "part1")).toBeNull();
    });

  it("verifies the original byte count and SHA-256 before any Telegram upload", () => {
    expect(verifyRequestedTrialBytes(original, bytes)).toBe(original.sha256);
    expect(() => verifyRequestedTrialBytes(original, bytes.subarray(1))).toThrow("original_file_mismatch");
    expect(() => verifyRequestedTrialBytes(original, Buffer.alloc(bytes.length))).toThrow("original_file_mismatch");
  });

  it("disables each completed part and closes the credential after all four originals", async () => {
    const f = fixture();
    for (const language of ["ru", "kk"] as const) {
      for (const part of ["part1", "part2"] as const) {
        await completeRequestedTrialUpload(f.database, language, part, `${language}-${part}-file`);
        expect(await authorizeRequestedTrialUpload(f.database, secret, language, part)).toBeNull();
      }
    }
    expect(f.state()).toMatchObject({ status: "done", secretSha256: "" });
    expect(f.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(4);
    expect(f.release).toHaveBeenCalledTimes(4);
  });

  it("keeps a part retryable if its completion transaction fails", async () => {
    const f = fixture();
    f.fail();
    await expect(completeRequestedTrialUpload(f.database, "ru", "part1", "file"))
      .rejects.toThrow("database failure");
    expect(f.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(f.state().parts.ru_part1.fileId).toBeUndefined();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
