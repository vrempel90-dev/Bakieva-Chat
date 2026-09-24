import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ settings: new Map<string, string>(), queries: vi.fn(),
  issuedLink: "https://t.me/+paid-talk", issuedTo: 123 }));
vi.mock("pg", () => ({ default: { Pool: class { query = state.queries; } } }));
vi.mock("./config.js", () => ({ config: {
  DATABASE_URL: "postgres://localhost/test",
  paidChannelId: -1004476014410,
  paidMainChatId: -1004333394152,
  talkChatId: -1004333394152
} }));

import { getPaidChannelId, getPaidMainChatId, isManagedMainChatJoinRequest,
  markManagedMainChatJoinApproved, setPaidChannelId } from "./db.js";

describe("paid access targets: channel and Bolталка", () => {
  beforeEach(() => {
    state.settings.clear();
    state.queries.mockReset().mockImplementation(async (sql: string, args: unknown[]) => {
      if (sql.includes("FROM access_deliveries") || sql.includes("UPDATE access_deliveries")) return {
        rowCount: args[0] === state.issuedTo && args[1] === state.issuedLink && args[2] === -1004333394152 ? 1 : 0
      };
      const value = state.settings.get(String(args[0]));
      return { rowCount: value === undefined ? 0 : 1, rows: value === undefined ? [] : [{ value }] };
    });
  });

  it("uses the operator supplied channel ID when no database override exists", async () => {
    expect(await getPaidChannelId()).toBe(-1004476014410);
    expect(await getPaidMainChatId()).toBe(-1004333394152);
  });

  it("does not route channel access to a stale database binding", async () => {
    state.settings.set("paid_channel_id", "-1004333394152");
    expect(await getPaidChannelId()).toBe(-1004476014410);
  });

  it("allows the configured Bolталка as the group and forbids binding it as the channel", async () => {
    state.settings.set("paid_main_chat_id", "-1009999999999");
    expect(await getPaidMainChatId()).toBe(-1004333394152);
    await expect(setPaidChannelId(-1004333394152)).rejects.toThrow("talk chat");
    expect(state.queries).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO settings"), expect.anything());
  });

  it("only recognizes join requests using this subscriber's paid group link", async () => {
    expect(await isManagedMainChatJoinRequest(123, state.issuedLink)).toBe(true);
    expect(await isManagedMainChatJoinRequest(456, state.issuedLink)).toBe(false);
    expect(await isManagedMainChatJoinRequest(123, "https://t.me/+old-link")).toBe(false);
    expect(await isManagedMainChatJoinRequest(123, undefined)).toBe(false);
    expect(await markManagedMainChatJoinApproved(123, state.issuedLink)).toBe(true);
    expect(await markManagedMainChatJoinApproved(456, state.issuedLink)).toBe(false);
  });

  it("rejects a channel whose ID matches the DB configured talk chat", async () => {
    state.settings.set("talk_chat_id", "-1004476014410");
    expect(await getPaidChannelId()).toBe(0);
  });
});
