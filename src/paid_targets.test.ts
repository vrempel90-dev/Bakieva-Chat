import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: new Map<string, string>(), queries: vi.fn() }));
vi.mock("pg", () => ({ default: { Pool: class { query = state.queries; } } }));
vi.mock("./config.js", () => ({ config: {
  DATABASE_URL: "postgres://localhost/test",
  paidChannelId: -1004476014410,
  paidMainChatId: 0,
  talkChatId: -1004333394152
} }));

import { getPaidChannelId, getPaidMainChatId, setPaidChannelId } from "./db.js";

describe("paid targets exclude Bolталка", () => {
  beforeEach(() => {
    state.settings.clear();
    state.queries.mockReset().mockImplementation(async (_sql: string, args: unknown[]) => {
      const value = state.settings.get(String(args[0]));
      return { rowCount: value === undefined ? 0 : 1, rows: value === undefined ? [] : [{ value }] };
    });
  });

  it("uses the operator supplied channel ID when no database override exists", async () => {
    expect(await getPaidChannelId()).toBe(-1004476014410);
    expect(await getPaidMainChatId()).toBe(0);
  });

  it("rejects a stale database channel override pointing to Bolталка", async () => {
    state.settings.set("paid_channel_id", "-1004333394152");
    expect(await getPaidChannelId()).toBe(0);
  });

  it("rejects Bolталка as the main paid chat and when binding the channel", async () => {
    state.settings.set("paid_main_chat_id", "-1004333394152");
    expect(await getPaidMainChatId()).toBe(0);
    await expect(setPaidChannelId(-1004333394152)).rejects.toThrow("talk chat");
    expect(state.queries).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO settings"), expect.anything());
  });

  it("rejects a channel whose ID matches the DB configured talk chat", async () => {
    state.settings.set("talk_chat_id", "-1004476014410");
    expect(await getPaidChannelId()).toBe(0);
  });
});
