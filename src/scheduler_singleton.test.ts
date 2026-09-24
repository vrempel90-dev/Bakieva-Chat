import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("./config.js", () => ({ config: { adminIds: new Set(), ADMIN_TIMEZONE: "Asia/Almaty", ADMIN_REPORT_HOUR: 21 } }));
vi.mock("./db.js", () => ({
  getPaidChatId: async () => 0,
  getSetting: async () => "",
  dueForReminder: async () => [],
  expiredSubscriptions: async () => [],
  dueAccessDeliveries: async () => [],
  LEGACY_EXPIRES_AT: new Date("2026-10-12")
}));
vi.mock("./access.js", () => ({ removeAccess: vi.fn(), sendAccess: vi.fn() }));
import { schedulerActive, startScheduler } from "./scheduler.js";
import type { Bot } from "grammy";

describe("scheduler singleton", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });
  it("starts once per instance and releases its timer on shutdown", () => {
    stop = startScheduler({ api: {} } as Bot);
    expect(schedulerActive).toBe(true);
    expect(() => startScheduler({ api: {} } as Bot)).toThrow("Scheduler already started");
    stop();
    expect(schedulerActive).toBe(false);
    stop = startScheduler({ api: {} } as Bot);
    expect(schedulerActive).toBe(true);
  });
});
