import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const record: Record<string, unknown> = {};
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes("SELECT * FROM access_deliveries")) return { rows: [{ ...record }] };
    if (sql.includes("UPDATE access_deliveries SET status=$2")) record.status = args[1];
    if (sql.includes("UPDATE access_deliveries SET status='access_delivered'")) record.status = "access_delivered";
    return { rows: [] };
  });
  return { record, query, release: vi.fn() };
});
vi.mock("./db.js", () => ({
  pool: { connect: vi.fn(async () => ({ query: mocks.query, release: mocks.release })) },
  getPaidChannelId: vi.fn(async () => -1004476014410),
  getPaidMainChatId: vi.fn(async () => -100200),
  getUserLanguage: vi.fn(async () => "ru"),
  isSubscriptionActive: vi.fn(async () => false)
}));

import { checkAccessTargets, removeAccess, retryTelegram, sendAccess } from "./access.js";
import { isSubscriptionActive } from "./db.js";
import type { Bot } from "grammy";

function botFixture(options: { mainMember?: boolean; failMain?: boolean } = {}) {
  const api = {
    getMe: vi.fn(async () => ({ id: 42 })),
    getChat: vi.fn(async (id: number) => ({ type: id === -1004476014410 ? "channel" : "supergroup" })),
    getChatMember: vi.fn(async (_id: number, member: number) => member === 42
      ? { status: "administrator", can_invite_users: true }
      : { status: _id === -100200 && options.mainMember ? "member" : "left" }),
    createChatInviteLink: vi.fn(async (id: number, _options?: unknown) => {
      if (id === -100200 && options.failMain) throw { error_code: 403, description: "Forbidden" };
      return { invite_link: `https://t.me/+${id}` };
    }),
    banChatMember: vi.fn(async (_id: number, _user?: number) => true),
    unbanChatMember: vi.fn(async (_id: number, _user?: number) => true),
    sendMessage: vi.fn(async () => ({}))
  };
  return { bot: { api } as unknown as Bot, api };
}

describe("paid access delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.record)) delete mocks.record[key];
  });

  it("checks both targets and excludes the legacy talk chat", async () => {
    const { bot, api } = botFixture();
    expect(await checkAccessTargets(bot)).toEqual({ channelId: -1004476014410, mainChatId: -100200 });
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    expect(api.createChatInviteLink.mock.calls.map(call => call[0])).toEqual([-1004476014410, -100200]);
    expect(api.createChatInviteLink.mock.calls.map(call => call[0])).not.toContain(-1004333394152);
    for (const call of api.createChatInviteLink.mock.calls) {
      expect(call[1]).toMatchObject({ creates_join_request: true });
      expect(call[1]).not.toHaveProperty("member_limit");
    }
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.record.status).toBe("access_delivered");
  });

  it("records partial access when main chat rejects an invite", async () => {
    const { bot, api } = botFixture({ failMain: true });
    await expect(sendAccess(bot, 123, new Date(Date.now() + 86400_000))).rejects.toMatchObject({ error_code: 403 });
    expect(api.createChatInviteLink).toHaveBeenCalledTimes(2);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mocks.record.status).toBe("access_partial");
  });

  it("does not create an invite for an existing member", async () => {
    const { bot, api } = botFixture({ mainMember: true });
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    expect(api.createChatInviteLink.mock.calls.map(call => call[0])).toEqual([-1004476014410]);
  });

  it("treats Telegram's user-not-found response as a new member", async () => {
    const { bot, api } = botFixture();
    api.getChatMember.mockImplementation(async (_id: number, member: number) => {
      if (member === 42) return { status: "administrator", can_invite_users: true };
      throw { error_code: 400, description: "Bad Request: user not found" };
    });
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    expect(api.createChatInviteLink).toHaveBeenCalledTimes(2);
  });

  it("retries 429 but never retries 403", async () => {
    const action = vi.fn().mockRejectedValueOnce({ error_code: 429, parameters: { retry_after: 1 } }).mockResolvedValue("ok");
    const wait = vi.fn(async () => {});
    expect(await retryTelegram(action, wait)).toBe("ok");
    expect(wait).toHaveBeenCalledWith(1000);
    action.mockReset().mockRejectedValue({ error_code: 403 });
    await expect(retryTelegram(action, wait)).rejects.toMatchObject({ error_code: 403 });
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not revoke renewed subscribers and never targets the talk chat", async () => {
    const { bot, api } = botFixture();
    vi.mocked(isSubscriptionActive).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await removeAccess(bot, 123);
    expect(api.banChatMember).not.toHaveBeenCalled();
    await removeAccess(bot, 123);
    expect(api.banChatMember.mock.calls.map(call => call[0])).toEqual([-1004476014410, -100200]);
    expect(api.banChatMember.mock.calls.map(call => call[0])).not.toContain(-1004333394152);
  });
});
