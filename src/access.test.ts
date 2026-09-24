import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const record: Record<string, unknown> = {};
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes("SELECT * FROM access_deliveries")) return { rows: [{ ...record }] };
    if (sql.includes("main_chat_join_approved_at IS NOT NULL")) return {
      rowCount: record.main_chat_join_approved_at && record.main_chat_id === args[1] ? 1 : 0
    };
    if (sql.includes("SET main_chat_invite=$2")) {
      record.main_chat_invite = args[1];
      record.main_chat_invite_expires_at = new Date(Number(args[2]) * 1000);
      record.main_chat_id = args[3];
      delete record.main_chat_join_approved_at;
    }
    if (sql.includes("CASE WHEN main_chat_id=$2")) {
      if (record.main_chat_id !== args[1]) {
        delete record.main_chat_invite;
        delete record.main_chat_invite_expires_at;
        delete record.main_chat_join_approved_at;
      }
      record.main_chat_id = args[1];
    }
    if (sql.includes("SET channel_invite=$2")) {
      record.channel_invite = args[1];
      record.channel_invite_expires_at = new Date(Number(args[2]) * 1000);
      record.channel_chat_id = args[3];
    }
    if (sql.includes("UPDATE access_deliveries SET status=$2")) record.status = args[1];
    if (sql.includes("UPDATE access_deliveries SET status='access_delivered'")) record.status = "access_delivered";
    return { rows: [] };
  });
  return { record, query, release: vi.fn() };
});
vi.mock("./db.js", () => ({
  pool: { connect: vi.fn(async () => ({ query: mocks.query, release: mocks.release })) },
  getPaidChannelId: vi.fn(async () => -1004476014410),
  getPaidMainChatId: vi.fn(async () => -1004333394152),
  getSetting: vi.fn(async (key: string) => key === "talk_chat_id" ? "-1004333394152" : "0"),
  getUserLanguage: vi.fn(async () => "ru"),
  isManagedMainChatJoinRequest: vi.fn(async (userId: number, url?: string) =>
    userId === 123 && url === "https://t.me/+paid-talk"),
  isSubscriptionActive: vi.fn(async () => true)
}));
vi.mock("./config.js", () => ({ config: { talkChatId: -1004333394152 } }));

import { checkAccessTargets, paidJoinRequestDecision, removeAccess, retryTelegram, sendAccess } from "./access.js";
import { isSubscriptionActive } from "./db.js";
import type { Bot } from "grammy";

function botFixture(options: { mainMember?: boolean; failMain?: boolean } = {}) {
  const api = {
    getMe: vi.fn(async () => ({ id: 42 })),
    getChat: vi.fn(async (id: number) => ({ type: id === -1004476014410 ? "channel" : "supergroup" })),
    getChatMember: vi.fn(async (_id: number, member: number) => member === 42
      ? { status: "administrator", can_invite_users: true }
      : { status: _id === -1004333394152 && options.mainMember ? "member" : "left" }),
    createChatInviteLink: vi.fn(async (id: number, _options?: unknown) => {
      if (id === -1004333394152 && options.failMain) throw { error_code: 403, description: "Forbidden" };
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
    vi.mocked(isSubscriptionActive).mockResolvedValue(true);
    for (const key of Object.keys(mocks.record)) delete mocks.record[key];
  });

  it("creates distinct channel and Bolталка links after an active payment", async () => {
    const { bot, api } = botFixture();
    expect(await checkAccessTargets(bot)).toEqual({ channelId: -1004476014410, mainChatId: -1004333394152 });
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    expect(api.createChatInviteLink.mock.calls.map(call => call[0])).toEqual([-1004476014410, -1004333394152]);
    for (const call of api.createChatInviteLink.mock.calls) {
      expect(call[1]).toMatchObject({ creates_join_request: true });
      expect(call[1]).not.toHaveProperty("member_limit");
    }
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.record.status).toBe("access_delivered");
    expect(mocks.record.main_chat_id).toBe(-1004333394152);
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
    vi.mocked(isSubscriptionActive).mockResolvedValueOnce(false);
    await removeAccess(bot, 123);
    expect(api.banChatMember.mock.calls.map(call => call[0])).toEqual([-1004476014410]);
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

  it("only revokes a Bolталка member who received the paid invitation", async () => {
    const { bot, api } = botFixture();
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    mocks.record.main_chat_join_approved_at = new Date();
    vi.mocked(isSubscriptionActive).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await removeAccess(bot, 123);
    expect(api.banChatMember).not.toHaveBeenCalled();
    await removeAccess(bot, 123);
    expect(api.banChatMember.mock.calls.map(call => call[0])).toEqual([-1004476014410, -1004333394152]);
  });

  it("does not remove someone from Болталка merely because an invite was issued", async () => {
    const { bot, api } = botFixture();
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    vi.mocked(isSubscriptionActive).mockResolvedValueOnce(false);
    await removeAccess(bot, 123);
    expect(api.banChatMember.mock.calls.map(call => call[0])).toEqual([-1004476014410]);
  });

  it("does not send access after the subscription expires", async () => {
    const { bot, api } = botFixture();
    vi.mocked(isSubscriptionActive).mockResolvedValueOnce(false);
    await expect(sendAccess(bot, 123, new Date())).rejects.toThrow("Subscription is not active");
    expect(api.createChatInviteLink).not.toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("reuses both unexpired links on a delivery retry", async () => {
    const { bot, api } = botFixture();
    const until = new Date(Date.now() + 86400_000);
    await sendAccess(bot, 123, until);
    await sendAccess(bot, 123, until);
    expect(api.createChatInviteLink).toHaveBeenCalledTimes(2);
  });

  it("replaces a link for a different chat after switching paid targets", async () => {
    Object.assign(mocks.record, { main_chat_id: -100200, main_chat_invite: "https://t.me/+old-chat",
      main_chat_invite_expires_at: new Date(Date.now() + 3600_000) });
    const { bot, api } = botFixture();
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    expect(api.createChatInviteLink.mock.calls.map(call => call[0])).toContain(-1004333394152);
    expect(mocks.record.main_chat_invite).toBe("https://t.me/+-1004333394152");
  });

  it("keeps a pre-existing Bolталка member despite an old chat's paid link", async () => {
    Object.assign(mocks.record, { main_chat_id: -100200, main_chat_invite: "https://t.me/+old-chat",
      main_chat_invite_expires_at: new Date(Date.now() + 3600_000) });
    const { bot, api } = botFixture({ mainMember: true });
    await sendAccess(bot, 123, new Date(Date.now() + 86400_000));
    vi.mocked(isSubscriptionActive).mockResolvedValueOnce(false);
    await removeAccess(bot, 123);
    expect(api.banChatMember.mock.calls.map(call => call[0])).toEqual([-1004476014410]);
  });

  it("approves active subscribers and declines expired ones using paid links", async () => {
    const target = -1004333394152;
    expect(await paidJoinRequestDecision(target, 123, "https://t.me/+paid-talk"))
      .toEqual({ action: "approve", mainChatId: target });
    vi.mocked(isSubscriptionActive).mockResolvedValueOnce(false);
    expect(await paidJoinRequestDecision(target, 123, "https://t.me/+paid-talk"))
      .toEqual({ action: "decline", mainChatId: target });
  });

  it("ignores other Bolталка links and join requests for other subscribers", async () => {
    const target = -1004333394152;
    expect(await paidJoinRequestDecision(target, 123, "https://t.me/+other"))
      .toEqual({ action: "ignore", mainChatId: target });
    expect(await paidJoinRequestDecision(target, 456, "https://t.me/+paid-talk"))
      .toEqual({ action: "ignore", mainChatId: target });
    expect(await paidJoinRequestDecision(target, 123))
      .toEqual({ action: "ignore", mainChatId: target });
    expect(vi.mocked(isSubscriptionActive)).not.toHaveBeenCalled();
  });
});
