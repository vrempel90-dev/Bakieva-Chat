import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Bot, GrammyError } from "grammy";
import {
  migrate,
  pool,
  ensureUser,
  acceptConsent,
  setMarketing,
  createNewsPublication,
  getLatestNewsPublication,
  recordNewsDelivery,
} from "./db.js";
import {
  acceptDataConsent,
  approvePayment,
  assignLegacyPlan,
  cancelPayment,
  claimPayment,
  confirmPhone,
  eligible,
  getPlans,
  grantSubscription,
  profile,
  proposePhone,
  requestPhone,
  resumePurchase,
  revokeSubscription,
  seedPlans,
  selectPlan,
  updatePlan,
} from "./commerce.js";
import {
  expireAccess,
  handleJoin,
  removeAccess,
  sendAccess,
} from "./access.js";
import {
  buyerRegistry,
  chunks,
  contactsExport,
  csv,
  dailyReports,
  deliverDaily,
  localDay,
  resolveReportPart,
  salesCsv,
  salesData,
  salesText,
  shiftDay,
  validPeriod,
} from "./sales.js";
import { normalizePhone } from "./phone.js";
import { createBot } from "./bot.js";
import { saveMemberEvent, membershipStats } from "./member-db.js";
import { runMigrations } from "./migrations.js";
import { anonymizeBuyer } from "./privacy.js";
import { CONSENT_VERSION } from "./config.js";
import { publicError } from "./errors.js";

let lite: PGlite | undefined;
const native = Boolean(process.env.TEST_DATABASE_URL);
const api = () => ({
  api: {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 123 }),
    sendDocument: vi.fn().mockResolvedValue({ message_id: 124 }),
    createChatInviteLink: vi.fn().mockImplementation(async (chat: number) => ({
      invite_link: `https://t.me/+${chat}-${Math.random()}`,
    })),
    approveChatJoinRequest: vi.fn().mockResolvedValue(true),
    declineChatJoinRequest: vi.fn().mockResolvedValue(true),
    banChatMember: vi.fn().mockResolvedValue(true),
    unbanChatMember: vi.fn().mockResolvedValue(true),
  },
});
type Fake = ReturnType<typeof api>;
const asBot = (b: Fake) => b as unknown as Bot;
async function user(id = 10) {
  await ensureUser({
    id,
    first_name: "Покупатель " + id,
    username: "buyer" + id,
  });
  await acceptConsent(id, CONSENT_VERSION);
}
let updateId = 1000;
async function purchase(plan = "month", id = 10) {
  await user(id);
  const p = await selectPlan(id, plan, updateId++);
  await claimPayment(id, Number(p.id));
  return p;
}
async function phone(id = 10) {
  await acceptDataConsent(id);
  await requestPhone(id);
  const p = await proposePhone(id, "+7 701 123 45 67");
  await confirmPhone(id, p.token);
}
async function paid(plan = "month", id = 10) {
  const p = await purchase(plan, id);
  await approvePayment(Number(p.id), 1);
  await phone(id);
  return p;
}
async function payment(id: number) {
  return (await pool.query("SELECT * FROM payments WHERE id=$1", [id])).rows[0];
}
function handlerBot() {
  const bot = createBot();
  bot.botInfo = {
    id: 999,
    is_bot: true,
    first_name: "Test",
    username: "test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const calls = vi
    .fn()
    .mockImplementation(async (method: string, payload: any) => ({
      ok: true,
      result:
        method === "createChatInviteLink"
          ? {
              invite_link: `https://t.me/+handler-${payload.chat_id}-${Math.random()}`,
            }
          : method === "getChat"
            ? {
                id: payload.chat_id,
                type: "supergroup",
                title: "Test community",
              }
            : { message_id: 123 },
    }));
  bot.api.config.use(async (_prev, method, payload) => calls(method, payload));
  const message = (id: number, text: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: 1,
        chat: { id, type: "private", first_name: "Test" },
        from: { id, is_bot: false, first_name: "Test" },
        text,
        ...(text.startsWith("/")
          ? {
              entities: [
                {
                  type: "bot_command" as const,
                  offset: 0,
                  length: text.split(" ")[0].length,
                },
              ],
            }
          : {}),
      },
    });
  const callback = (id: number, data: string) =>
    bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: "cb" + updateId,
        from: { id, is_bot: false, first_name: "Test" },
        chat_instance: "1",
        data,
        message: {
          message_id: 1,
          date: 1,
          chat: { id, type: "private", first_name: "Test" },
          text: "card",
        },
      },
    });
  return { bot, calls, message, callback };
}

beforeAll(async () => {
  if (!native) {
    lite = new PGlite();
    await lite.waitReady;
    const query = async (sql: string, args?: unknown[]) => {
      const r = args?.length
        ? await lite!.query(sql, args)
        : (await lite!.exec(sql)).at(-1)!;
      return {
        ...r,
        rowCount: /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)
          ? r.affectedRows
          : r.rows.length,
      };
    };
    vi.spyOn(pool, "query").mockImplementation(query as never);
    vi.spyOn(pool, "connect").mockImplementation((async () => ({
      query,
      release() {},
    })) as never);
  }
  await migrate();
  await seedPlans();
});
beforeEach(async () => {
  await pool.query(
    "TRUNCATE users,plans,settings,report_deliveries,admin_actions,admin_flows,chat_memberships,membership_events,news_publications CASCADE",
  );
  await seedPlans();
});
afterAll(async () => {
  vi.restoreAllMocks();
  await lite?.close();
  await pool.end();
});

describe("purchases, profile and access", () => {
  it.each([
    ["month", "1 месяц", 5000, 30],
    ["half_year", "6 месяцев", 25000, 180],
  ])("buys %s with immutable terms", async (plan, name, price, days) => {
    const p = await purchase(plan as string);
    expect(p.plan_name).toBe(name);
    expect(p.amount).toBe(price);
    expect(p.plan_days).toBe(days);
    await updatePlan(plan as string, 12345, 45);
    expect((await payment(p.id)).amount).toBe(price);
    await approvePayment(Number(p.id), 1);
    await phone();
    const row = await payment(p.id);
    expect(row.status).toBe("approved");
    expect(row.access_status).toBe("ready");
    expect(
      (new Date(row.subscription_end).getTime() -
        new Date(row.subscription_start).getTime()) /
        86400000,
    ).toBe(days);
  });
  it("a claim is not a verified sale and grants no access", async () => {
    const p = await purchase();
    const b = api();
    expect(await sendAccess(asBot(b), 10)).toBe(false);
    expect((await payment(p.id)).status).toBe("pending");
    expect(await buyerRegistry()).toHaveLength(0);
    expect(b.api.createChatInviteLink).not.toHaveBeenCalled();
  });
  it("only an administrator can confirm; an unclaimed draft cannot be approved", async () => {
    const p = await purchase();
    await expect(approvePayment(Number(p.id), 99)).rejects.toThrow(
      "Нет доступа",
    );
    await cancelPayment(10, Number(p.id));
    expect((await payment(p.id)).status).toBe("pending");
    await user(20);
    const draft = await selectPlan(20, "month", updateId++);
    await expect(approvePayment(Number(draft.id), 1)).rejects.toThrow(
      "ещё не заявил",
    );
  });
  it("retains confirmed payment without WhatsApp, with no subscription or invitations", async () => {
    const p = await purchase();
    await approvePayment(Number(p.id), 1);
    const b = api();
    expect((await payment(p.id)).status).toBe("approved");
    expect((await payment(p.id)).access_status).toBe("waiting_profile");
    expect((await pool.query("SELECT * FROM subscriptions")).rowCount).toBe(0);
    expect(await sendAccess(asBot(b), 10)).toBe(false);
    const data = await salesData(localDay(), localDay());
    expect(data.rows).toHaveLength(1);
    expect(data.missingPhone).toBe(1);
  });
  it("requires consent, validates and explicitly confirms a personal contact", async () => {
    const p = await purchase();
    await approvePayment(Number(p.id), 1);
    await requestPhone(10);
    await expect(proposePhone(10, "+77011234567")).rejects.toThrow(
      "обработку данных",
    );
    await acceptDataConsent(10);
    await expect(proposePhone(10, "+77011234567", 99, true)).rejects.toThrow(
      "собственным",
    );
    await expect(
      proposePhone(10, "+77011234567", undefined, true),
    ).rejects.toThrow("собственным");
    const candidate = await proposePhone(10, "8 (701) 123-45-67", 10, true);
    expect((await profile(10)).whatsapp).toBeNull();
    expect(await confirmPhone(10, "wrong")).toBe(false);
    expect(await confirmPhone(10, candidate.token)).toBe(true);
    expect((await profile(10)).whatsapp).toBe("+77011234567");
    expect((await payment(p.id)).activated_at).not.toBeNull();
    expect((await profile(10)).marketing_opt_in).toBe(false);
  });
  it.each([
    "abc",
    "123",
    "+000123456789",
    "+7701123456789012345",
    "+7 000 000 00 00",
    "+77011234567 ext 2",
  ])("rejects invalid number %s", (s) => expect(normalizePhone(s)).toBeNull());
  it("accepts international numbers and lets the buyer correct a candidate", async () => {
    await paid();
    const before = (
      await payment((await pool.query("SELECT id FROM payments")).rows[0].id)
    ).subscription_end;
    await requestPhone(10);
    const a = await proposePhone(10, "+442079460018");
    const b = await proposePhone(10, "+77021234567");
    expect(await confirmPhone(10, a.token)).toBe(false);
    expect(await confirmPhone(10, b.token)).toBe(true);
    expect((await profile(10)).whatsapp).toBe("+77021234567");
    expect(
      (await pool.query("SELECT active_until FROM subscriptions")).rows[0]
        .active_until,
    ).toEqual(before);
  });
  it("renews an existing subscriber once without requesting the number again", async () => {
    const first = await paid();
    const end = new Date((await payment(first.id)).subscription_end).getTime();
    const second = await purchase("half_year");
    await approvePayment(Number(second.id), 1);
    expect(
      new Date((await payment(second.id)).subscription_end).getTime() - end,
    ).toBe(180 * 86400000);
    expect(await approvePayment(Number(second.id), 1)).toBeNull();
    await resumePurchase(10);
    await resumePurchase(10);
    expect(
      new Date((await payment(second.id)).subscription_end).getTime() - end,
    ).toBe(180 * 86400000);
    expect((await pool.query("SELECT * FROM payments")).rowCount).toBe(2);
  });
  it("retains the purchase on duplicate tariff updates even after approval", async () => {
    await user();
    const id = updateId++;
    const a = await selectPlan(10, "month", id);
    await claimPayment(10, Number(a.id));
    await approvePayment(Number(a.id), 1);
    await phone();
    const b = await selectPlan(10, "month", id);
    expect(b.id).toBe(a.id);
    expect((await pool.query("SELECT * FROM payments")).rowCount).toBe(1);
  });
  it("a stale claim callback cannot create a new purchase or claim another account purchase", async () => {
    const p = await paid();
    expect(await claimPayment(10, Number(p.id))).toBeNull();
    await user(20);
    expect(await claimPayment(20, Number(p.id))).toBeNull();
    expect((await pool.query("SELECT * FROM payments")).rowCount).toBe(1);
  });
  it("recovers persisted profile state and activates only once after a restart", async () => {
    const p = await purchase();
    await approvePayment(Number(p.id), 1);
    await acceptDataConsent(10);
    const candidate = await proposePhone(10, "+77011234567");
    expect((await profile(10)).phone_token).toBe(candidate.token);
    await resumePurchase(10);
    expect((await payment(p.id)).subscription_end).toBeNull();
    await confirmPhone(10, (await profile(10)).phone_token);
    const end = (await payment(p.id)).subscription_end;
    await resumePurchase(10);
    expect((await payment(p.id)).subscription_end).toEqual(end);
  });
  it("uses join requests and binds invitation URL, user ID and chat ID", async () => {
    await paid();
    const b = api();
    expect(await sendAccess(asBot(b), 10)).toBe(true);
    expect(b.api.createChatInviteLink.mock.calls[0][1]).toMatchObject({
      creates_join_request: true,
    });
    expect(b.api.createChatInviteLink.mock.calls[0][1]).not.toHaveProperty(
      "member_limit",
    );
    const invite = (
      await pool.query("SELECT * FROM access_invites WHERE chat_id=-100111")
    ).rows[0];
    await user(20);
    await handleJoin(asBot(b), 20, -100111, invite.invite_link);
    await handleJoin(asBot(b), 10, -100222, invite.invite_link);
    expect(b.api.approveChatJoinRequest).not.toHaveBeenCalled();
    expect(b.api.declineChatJoinRequest).toHaveBeenCalledTimes(2);
    await handleJoin(asBot(b), 10, -100111, invite.invite_link);
    expect(b.api.approveChatJoinRequest).toHaveBeenCalledWith(-100111, 10);
  });
  it("rejects unknown and expired invites and sends fresh links on request", async () => {
    await paid();
    const b = api();
    await sendAccess(asBot(b), 10);
    const invite = (
      await pool.query("SELECT * FROM access_invites WHERE chat_id=-100111")
    ).rows[0];
    await pool.query(
      "UPDATE access_invites SET expires_at=NOW()-interval '1 second'",
    );
    await handleJoin(asBot(b), 10, -100111, invite.invite_link);
    expect(b.api.approveChatJoinRequest).not.toHaveBeenCalled();
    await sendAccess(asBot(b), 10);
    expect(b.api.createChatInviteLink).toHaveBeenCalledTimes(4);
  });
  it("retries expiry after an API failure and never expires a newly renewed user", async () => {
    await paid();
    await pool.query(
      "UPDATE subscriptions SET active_until=NOW()-interval '1 second'",
    );
    const b = api();
    b.api.banChatMember.mockRejectedValueOnce(new Error("unavailable"));
    expect(await expireAccess(asBot(b), 10)).toBe(false);
    expect(
      (await pool.query("SELECT status FROM subscriptions")).rows[0].status,
    ).toBe("active");
    expect(await expireAccess(asBot(b), 10)).toBe(true);
    expect(
      (await pool.query("SELECT status FROM subscriptions")).rows[0].status,
    ).toBe("expired");
    const p = await purchase();
    await approvePayment(Number(p.id), 1);
    b.api.banChatMember.mockClear();
    expect(await expireAccess(asBot(b), 10)).toBe(false);
    expect(b.api.banChatMember).not.toHaveBeenCalled();
  });
  it("manual extensions are idempotent and cannot bypass paid profile conditions", async () => {
    await user();
    await expect(grantSubscription(10, 30, 1, updateId++)).rejects.toThrow(
      "оплата",
    );
    await paid();
    const action = updateId++;
    const end = await grantSubscription(10, 5, 1, action);
    expect(await grantSubscription(10, 5, 1, action)).toEqual(end);
  });
  it("revoke persists and removal failures can be retried", async () => {
    await paid();
    await revokeSubscription(10);
    const b = api();
    b.api.banChatMember.mockRejectedValueOnce(new Error());
    expect(await removeAccess(asBot(b), 10)).toBe(false);
    expect(await expireAccess(asBot(b), 10)).toBe(true);
    expect(await eligible(pool as never, 10)).toBe(false);
  });
  it("a late WhatsApp step cannot reactivate an explicitly revoked purchase", async () => {
    const p = await purchase();
    await approvePayment(Number(p.id), 1);
    await revokeSubscription(10);
    await phone();
    await resumePurchase(10);
    expect((await payment(p.id)).activated_at).toBeNull();
    expect((await payment(p.id)).access_status).toBe("revoked");
    expect(await sendAccess(asBot(api()), 10)).toBe(false);
  });
  it("can extend an expired paid subscriber manually without creating a fictitious sale", async () => {
    await paid();
    await pool.query(
      "UPDATE subscriptions SET status='expired',active_until=NOW()-interval '1 day'",
    );
    await grantSubscription(10, 5, 1, updateId++);
    expect(await eligible(pool as never, 10)).toBe(true);
    expect(await buyerRegistry()).toHaveLength(1);
  });
  it("keeps activation committed when Telegram delivery fails, so /access can retry", async () => {
    const p = await paid();
    const b = api();
    b.api.sendMessage.mockRejectedValueOnce(new Error("unavailable"));
    await expect(sendAccess(asBot(b), 10)).rejects.toThrow();
    expect((await payment(p.id)).access_status).toBe("ready");
    const until = (await payment(p.id)).subscription_end;
    expect(await sendAccess(asBot(b), 10)).toBe(true);
    expect((await payment(p.id)).subscription_end).toEqual(until);
  });
});

describe("sales and exports", () => {
  it("reports every confirmed buyer, per-plan counts and actual revenue", async () => {
    await paid("month", 10);
    await paid("half_year", 20);
    await purchase("month", 30);
    const d = await salesData(localDay(), localDay());
    const text = salesText(localDay(), localDay(), d);
    expect(d.rows).toHaveLength(2);
    expect(d.pending).toBe(1);
    expect(text).toContain("30");
    expect(text).toContain("Покупатель 10");
    expect(text).toContain("Покупатель 20");
    expect(text).toContain("1 месяц: 1");
    expect(text).toContain("6 месяцев: 1");
    expect(d.rows.reduce((s, p) => s + p.amount, 0)).toBe(30000);
  });
  it("reports an empty day honestly", async () => {
    const d = await salesData(localDay(), localDay());
    expect(d.rows).toEqual([]);
    expect(salesText(localDay(), localDay(), d)).toContain(
      "Подтверждённых покупок нет",
    );
    expect(salesCsv(d.rows).toString("utf8")).toContain("purchase_id");
  });
  it("uses Almaty day boundaries, including UTC dates and historic offset changes", async () => {
    const p = await paid();
    await pool.query(
      "UPDATE payments SET approved_at='2026-10-21T19:00:00Z' WHERE id=$1",
      [p.id],
    );
    expect((await salesData("2026-10-22", "2026-10-22")).rows).toHaveLength(1);
    expect((await salesData("2026-10-21", "2026-10-21")).rows).toHaveLength(0);
    expect(localDay(new Date("2026-10-21T19:00:00Z"))).toBe("2026-10-22");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("exports UTF-8 BOM, CRLF, quoting, and formula-safe cells", () => {
    const data = csv([
      ["name", "phone"],
      ['Амина, "Тест"', "+77011234567"],
      ["\t=cmd()", "@evil"],
    ]);
    expect([...data.subarray(0, 3)]).toEqual([239, 187, 191]);
    const text = data.toString("utf8");
    expect(text).toContain('Амина, ""Тест""');
    expect(text).toContain("'+77011234567");
    expect(text).toContain("'\t=cmd()");
    expect(text).toContain("\r\n");
  });
  it("never includes non-consenting contacts in marketing exports; withdrawal takes effect", async () => {
    await paid("month", 10);
    await paid("half_year", 20);
    await setMarketing(20, true);
    const allContacts = (await contactsExport()).toString("utf8");
    expect(allContacts).toContain("Покупатель 10");
    expect(allContacts).toContain('"+77011234567"');
    const text = (await contactsExport(true)).toString("utf8");
    expect(text).toContain("Покупатель 20");
    expect(text).not.toContain("Покупатель 10");
    await setMarketing(20, false);
    expect((await contactsExport(true)).toString("utf8")).not.toContain(
      "Покупатель 20",
    );
  });
  it("splits complete lists into Telegram-sized parts without dropping buyers", () => {
    const data = Array.from(
      { length: 500 },
      (_, i) => `Покупатель ${i}: ` + "x".repeat(100),
    ).join("\n");
    const parts = chunks(data);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 3501)).toBe(true);
    expect(parts.join("\n")).toContain("Покупатель 499");
    expect(chunks("x".repeat(9000)).length).toBe(3);
  });
  it("does not resend a daily report after restart", async () => {
    await paid();
    const b = api();
    await deliverDaily(asBot(b), 1, localDay());
    await deliverDaily(asBot(b), 1, localDay());
    expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(b.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT status FROM report_deliveries")).rows[0].status,
    ).toBe("sent");
  });
  it("retries a known Telegram rejection without repeating sent parts", async () => {
    const b = api();
    b.api.sendDocument.mockRejectedValueOnce(
      new GrammyError(
        "rejected",
        { ok: false, error_code: 429, description: "Too Many Requests" },
        "sendDocument",
        {},
      ),
    );
    await deliverDaily(asBot(b), 1, localDay());
    await deliverDaily(asBot(b), 1, localDay());
    expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(b.api.sendDocument).toHaveBeenCalledTimes(2);
  });
  it("stops an ambiguous network failure or interrupted sending state", async () => {
    const b = api();
    b.api.sendMessage.mockRejectedValueOnce(new Error("connection lost"));
    await deliverDaily(asBot(b), 1, localDay());
    await deliverDaily(asBot(b), 1, localDay());
    expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT status FROM report_deliveries")).rows[0].status,
    ).toBe("uncertain");
    await pool.query("UPDATE report_parts SET status='sending' WHERE part=0");
    await deliverDaily(asBot(b), 1, localDay());
    expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("requires an administrator to reconcile an ambiguous report and resumes remaining parts", async () => {
    const b = api();
    b.api.sendMessage.mockRejectedValueOnce(new Error());
    await deliverDaily(asBot(b), 1, localDay());
    const id = Number(
      (await pool.query("SELECT id FROM report_deliveries")).rows[0].id,
    );
    await expect(resolveReportPart(99, id, 0, "retry")).rejects.toThrow(
      "Нет доступа",
    );
    expect(await resolveReportPart(1, id, 0, "sent")).toBe(true);
    await deliverDaily(asBot(b), 1, localDay());
    expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(b.api.sendDocument).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT status FROM report_deliveries")).rows[0].status,
    ).toBe("sent");
  });
  it("sends yesterday at the configured local time and records the date", async () => {
    const b = api();
    await dailyReports(asBot(b), new Date("2026-10-22T03:59:00Z"));
    expect(b.api.sendMessage).not.toHaveBeenCalled();
    await dailyReports(asBot(b), new Date("2026-10-22T04:00:00Z"));
    expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT to_char(report_date,'YYYY-MM-DD') AS day FROM report_deliveries",
        )
      ).rows[0].day,
    ).toBe("2026-10-21");
  });
  it.each([
    ["2026-02-30", "2026-03-01"],
    ["bad", "2026-01-01"],
    ["2026-03-01", "2026-02-01"],
  ])("rejects an invalid period", (a, b) =>
    expect(validPeriod(a, b)).toBe(false),
  );
});

describe("migration, privacy, Telegram handlers and legacy features", () => {
  it("migrates a real 001 fixture without resetting payments, users, subscriptions or news", async () => {
    // Independent SQL database so the fixture can start with the exact historic schema.
    const legacy = new PGlite();
    await legacy.waitReady;
    const query = async (sql: string, args?: unknown[]) => {
      const r = args?.length
        ? await legacy.query(sql, args)
        : (await legacy.exec(sql)).at(-1)!;
      return { ...r, rowCount: r.rows.length };
    };
    await legacy.exec(
      await readFile(resolve("migrations/001_init.sql"), "utf8"),
    );
    await legacy.exec(`INSERT INTO users(telegram_id,first_name) VALUES(777,'Старый пользователь');
      INSERT INTO payments(user_id,provider,amount,status) VALUES(777,'kaspi_link',4000,'approved');
      INSERT INTO subscriptions(user_id,status,active_until) VALUES(777,'active','2030-01-01T00:00:00Z');
      INSERT INTO news_publications(admin_id,source_chat_id,source_message_id) VALUES(1,1,10);`);
    await runMigrations({ query } as never, resolve("migrations"));
    await runMigrations({ query } as never, resolve("migrations"));
    await legacy.exec(
      await readFile(resolve("migrations/002_commerce.sql"), "utf8"),
    );
    expect(
      (
        await legacy.query<{ active_until: Date }>(
          "SELECT active_until FROM subscriptions",
        )
      ).rows[0].active_until,
    ).toEqual(new Date("2030-01-01T00:00:00Z"));
    expect(
      (await legacy.query("SELECT amount,legacy,plan_days FROM payments"))
        .rows[0],
    ).toMatchObject({ amount: 4000, legacy: true, plan_days: null });
    expect(
      (
        await legacy.query<{ marketing_opt_in: boolean }>(
          "SELECT marketing_opt_in FROM users",
        )
      ).rows[0].marketing_opt_in,
    ).toBe(false);
    expect(
      (await legacy.query("SELECT * FROM news_publications")).rows,
    ).toHaveLength(1);
    await legacy.close();
  });
  it("anonymizes personal data while retaining confirmed financial history", async () => {
    await paid();
    const b = api();
    await deliverDaily(asBot(b), 1, localDay());
    await anonymizeBuyer(asBot(b), 10);
    const p = (await pool.query("SELECT * FROM payments")).rows[0];
    expect(p.user_id).toBeNull();
    expect(p.buyer_name).toBeNull();
    expect(p.whatsapp).toBeNull();
    expect(p.amount).toBe(5000);
    expect((await pool.query("SELECT * FROM users")).rows).toHaveLength(0);
    expect(await buyerRegistry()).toHaveLength(1);
    expect(
      JSON.stringify(
        (await pool.query("SELECT payload FROM report_parts")).rows,
      ),
    ).not.toContain("77011234567");
  });
  it("preserves news audit and membership accounting", async () => {
    await user();
    const id = await createNewsPublication(1, 1, 55);
    expect(id).not.toBeNull();
    await recordNewsDelivery(id!, {
      chatId: -100111,
      title: "Канал",
      username: null,
      status: "sent",
      messageId: 77,
      error: null,
    });
    expect((await getLatestNewsPublication(1))!.deliveries[0].messageId).toBe(
      77,
    );
    const when = new Date();
    expect(
      await saveMemberEvent(
        { chatId: -100111, userId: 10 },
        "joined",
        when,
        "chat_member",
      ),
    ).toBe(true);
    expect(
      await saveMemberEvent(
        { chatId: -100111, userId: 10 },
        "joined",
        when,
        "service_message",
      ),
    ).toBe(false);
    expect((await membershipStats([-100111]))[0].current).toBe(1);
    await saveMemberEvent(
      { chatId: -100111, userId: 10 },
      "left",
      new Date(when.getTime() + 1000),
      "chat_member",
    );
    expect(
      await saveMemberEvent(
        { chatId: -100111, userId: 10 },
        "joined",
        when,
        "chat_member",
      ),
    ).toBe(false);
    expect((await membershipStats([-100111]))[0].current).toBe(0);
  });
  it("runs the complete Telegram purchase flow through handlers across a restart", async () => {
    const app = handlerBot();
    await app.message(10, "/start");
    await app.callback(10, "consent:accept");
    await app.callback(10, "plan:half_year");
    const p = (await pool.query("SELECT * FROM payments")).rows[0];
    expect(p.amount).toBe(25000);
    await app.callback(10, `pay:claim:${p.id}`);
    expect((await payment(p.id)).status).toBe("pending");
    await app.callback(1, `pay:approve:${p.id}`);
    expect((await payment(p.id)).status).toBe("approved");
    expect(
      app.calls.mock.calls.filter((c) => c[0] === "createChatInviteLink"),
    ).toHaveLength(0);
    await app.callback(10, "data:accept");
    await app.message(10, "+7 701 123 45 67");
    const token = (await profile(10)).phone_token;
    expect(token).toBeTruthy();
    const restarted = handlerBot();
    await restarted.message(10, "/access");
    await restarted.callback(10, `phone:confirm:${token}`);
    expect((await payment(p.id)).access_status).toBe("invited");
    expect(
      restarted.calls.mock.calls.filter((c) => c[0] === "createChatInviteLink"),
    ).toHaveLength(2);
    await restarted.message(1, "/sales_today");
    expect(
      restarted.calls.mock.calls.filter((c) => c[0] === "sendDocument"),
    ).toHaveLength(1);
  });
  it("continues to publish news and collect Telegram membership service events", async () => {
    const app = handlerBot();
    await app.message(1, "/news");
    await app.message(1, "Новая публикация");
    expect(
      app.calls.mock.calls.filter((c) => c[0] === "copyMessage"),
    ).toHaveLength(3);
    expect(
      (await getLatestNewsPublication(1))?.deliveries.every(
        (p) => p.status === "sent",
      ),
    ).toBe(true);
    await app.bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: 55,
        date: 1700000000,
        chat: { id: -100111, type: "supergroup", title: "Paid" },
        from: { id: 10, is_bot: false, first_name: "Member" },
        new_chat_members: [{ id: 10, is_bot: false, first_name: "Member" }],
      },
    });
    expect((await membershipStats([-100111]))[0].current).toBe(1);
  });
  it("never exposes arbitrary error messages containing tokens or connection strings", () => {
    expect(
      publicError(new Error("postgres://user:secret@database")),
    ).not.toContain("secret");
    expect(
      publicError({ code: "23505", detail: "phone +77011234567" }),
    ).not.toContain("77011234567");
  });
  it("edits both tariffs through admin buttons and preserves exact public names", async () => {
    const app = handlerBot();
    await app.callback(1, "admin:plans");
    await app.callback(1, "admin:plan:month");
    await app.message(1, "6000 35");
    await app.message(1, "/plan half_year 26000 190");
    expect(await getPlans()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "month",
          name: "1 месяц",
          price: 6000,
          days: 35,
        }),
        expect.objectContaining({
          id: "half_year",
          name: "6 месяцев",
          price: 26000,
          days: 190,
        }),
      ]),
    );
    expect((await pool.query("SELECT * FROM admin_flows")).rows).toHaveLength(
      0,
    );
  });
  it("lists a repeat buyer once while exporting every purchase", async () => {
    await paid();
    const second = await purchase("half_year");
    await approvePayment(Number(second.id), 1);
    const app = handlerBot();
    await app.callback(1, "admin:buyers:0");
    const messages = app.calls.mock.calls
      .filter((c) => c[0] === "sendMessage")
      .map((c) => String(c[1].text));
    expect(messages.filter((t) => t.includes("Покупатель 10"))).toHaveLength(1);
    expect(messages.join("")).toContain("подтверждённых покупок: 2");
    expect(await buyerRegistry()).toHaveLength(2);
  });
  it("requires an explicit tariff assignment for a legacy pending payment and retains its actual amount", async () => {
    await user();
    const p = (
      await pool.query(`INSERT INTO payments(user_id,provider,amount,status,legacy,plan_id,plan_name,claimed_at)
      VALUES(10,'kaspi_link',4000,'pending',TRUE,'legacy','Архивный тариф',NOW()) RETURNING id`)
    ).rows[0];
    await expect(approvePayment(Number(p.id), 1)).rejects.toThrow(
      "payment_plan",
    );
    await assignLegacyPlan(Number(p.id), "month");
    await approvePayment(Number(p.id), 1);
    await phone();
    expect((await payment(p.id)).amount).toBe(4000);
    expect((await payment(p.id)).plan_days).toBe(30);
  });
  it("protects all admin commands and callbacks from a regular user and group chats", async () => {
    const bot = createBot();
    bot.botInfo = {
      id: 999,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
      can_manage_bots: false,
      supports_join_request_queries: false,
    };
    const call = vi
      .fn()
      .mockResolvedValue({ ok: true, result: { message_id: 1 } });
    bot.api.config.use(async (_prev, method, payload) => call(method, payload));
    for (const command of [
      "/admin",
      "/sales_today",
      "/sales_yesterday",
      "/sales_report 2026-01-01 2026-01-02",
      "/sales_export",
      "/contacts_marketing",
      "/price 1",
      "/plan month 1",
      "/grant 10 100",
      "/revoke 10",
      "/sales_resolve 1 0 retry",
    ]) {
      await bot.handleUpdate({
        update_id: updateId++,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 20, type: "private", first_name: "Test" },
          from: { id: 20, is_bot: false, first_name: "Test" },
          text: command,
          entities: [
            {
              type: "bot_command",
              offset: 0,
              length: command.split(" ")[0].length,
            },
          ],
        },
      });
    }
    expect(call).not.toHaveBeenCalled();
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: "cb",
        from: { id: 20, is_bot: false, first_name: "Test" },
        chat_instance: "1",
        data: "pay:approve:1",
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 20, type: "private", first_name: "Test" },
          text: "x",
        },
      },
    });
    expect(call.mock.calls.at(-1)?.[0]).toBe("answerCallbackQuery");
    call.mockClear();
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: -123, type: "group", title: "Group" },
        from: { id: 1, is_bot: false, first_name: "Admin" },
        text: "/sales_export",
        entities: [{ type: "bot_command", offset: 0, length: 13 }],
      },
    });
    expect(call).not.toHaveBeenCalled();
  });
});

describe.skipIf(!native)("native PostgreSQL concurrency (CI service)", () => {
  it("serializes simultaneous confirmations and activations", async () => {
    const p = await purchase();
    await phone();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => approvePayment(Number(p.id), 1)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const r = await payment(p.id);
    expect(
      (new Date(r.subscription_end).getTime() -
        new Date(r.subscription_start).getTime()) /
        86400000,
    ).toBe(30);
  });
  it("does not lose concurrent renewals or create duplicate pending purchases", async () => {
    await paid();
    const first = (await pool.query("SELECT active_until FROM subscriptions"))
      .rows[0].active_until;
    const candidates = await Promise.all(
      Array.from({ length: 8 }, () => selectPlan(10, "month", updateId++)),
    );
    expect(new Set(candidates.map((p) => p.id)).size).toBe(1);
    await claimPayment(10, Number(candidates[0].id));
    await Promise.all(
      Array.from({ length: 8 }, () =>
        approvePayment(Number(candidates[0].id), 1),
      ),
    );
    expect(
      new Date(
        (await pool.query("SELECT active_until FROM subscriptions")).rows[0]
          .active_until,
      ).getTime() - new Date(first).getTime(),
    ).toBe(30 * 86400000);
  });
  it("serializes concurrent report deliveries across workers", async () => {
    const b = api();
    await Promise.all(
      Array.from({ length: 4 }, () => deliverDaily(asBot(b), 1, localDay())),
    );
    expect(b.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(b.api.sendDocument).toHaveBeenCalledTimes(1);
  });
  it("does not approve a join after revocation wins the user lock", async () => {
    await paid();
    const b = api();
    await sendAccess(asBot(b), 10);
    const link = (
      await pool.query(
        "SELECT invite_link FROM access_invites WHERE chat_id=-100111",
      )
    ).rows[0].invite_link;
    await revokeSubscription(10);
    await Promise.all([
      handleJoin(asBot(b), 10, -100111, link),
      expireAccess(asBot(b), 10),
    ]);
    expect(b.api.approveChatJoinRequest).not.toHaveBeenCalled();
  });
  it("records a concurrent membership event once without duplicate join notifications", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        saveMemberEvent(
          { chatId: -100111, userId: 10 },
          "joined",
          new Date("2026-10-22T10:00:00Z"),
          "chat_member",
        ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await pool.query("SELECT * FROM membership_events")).rowCount).toBe(
      1,
    );
  });
});
