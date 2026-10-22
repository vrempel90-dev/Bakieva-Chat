import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  events: [] as string[],
  ready: undefined as undefined | (() => boolean),
  check: undefined as undefined | (() => Promise<unknown>),
}));
vi.mock("./db.js", () => ({
  migrate: async () => {
    state.events.push("migrate");
  },
  pool: {
    query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
    end: async () => {
      state.events.push("pool.end");
    },
  },
}));
vi.mock("./commerce.js", () => ({
  seedPlans: async () => {
    state.events.push("seed");
  },
}));
vi.mock("./health.js", () => ({
  healthServer: (check: () => Promise<unknown>, ready: () => boolean) => {
    state.check = check;
    state.ready = ready;
    return {
      listen: () => {
        state.events.push("listen");
      },
      close: () => {
        state.events.push("close");
      },
    };
  },
}));
vi.mock("./scheduler.js", () => ({
  startScheduler: () => {
    state.events.push("scheduler");
    return async () => {
      state.events.push("scheduler.stop");
    };
  },
}));
vi.mock("./bot.js", () => ({
  createBot: () => ({
    api: {
      setMyName: async () => {
        state.events.push("name");
      },
      setMyCommands: async () => {
        state.events.push("commands");
      },
    },
    isRunning: () => false,
    stop: vi.fn(),
    start: async (options: {
      drop_pending_updates: boolean;
      allowed_updates: string[];
      onStart: (info: { username: string }) => void;
    }) => {
      expect(state.events.slice(0, 3)).toEqual(["migrate", "seed", "listen"]);
      expect(state.ready?.()).toBe(false);
      expect(options.drop_pending_updates).toBe(false);
      expect(options.allowed_updates).toContain("chat_join_request");
      expect(options.allowed_updates).toContain("chat_member");
      options.onStart({ username: "test" });
      expect(state.ready?.()).toBe(true);
      await state.check?.();
      state.events.push("polling");
    },
  }),
}));
it("boots the actual entrypoint after migrations, starts polling and scheduler, and closes resources", async () => {
  const once = vi.spyOn(process, "once").mockReturnValue(process);
  try {
    await import("./index.js");
    expect(state.events).toEqual([
      "migrate",
      "seed",
      "listen",
      "name",
      "commands",
      "scheduler",
      "polling",
      "close",
      "scheduler.stop",
      "pool.end",
    ]);
    expect(state.ready?.()).toBe(false);
    expect(once).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  } finally {
    once.mockRestore();
  }
});
