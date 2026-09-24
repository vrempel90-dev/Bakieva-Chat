import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const store = {
    approved: false, count: 0, extensionDays: 0, owner: 123,
    key: "", lock: Promise.resolve() as Promise<void>, lastUserLockSql: ""
  };
  const connect = vi.fn(async () => {
    let unlock: (() => void) | null = null;
    return {
    release: vi.fn(),
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes("pg_advisory_xact_lock($1,")) store.lastUserLockSql = sql;
      if (sql.includes("pg_advisory_xact_lock(hashtext")) {
        const previous = store.lock;
        store.lock = new Promise<void>(resolve => { unlock = resolve; });
        await previous;
      }
      if (sql === "COMMIT" || sql === "ROLLBACK") { unlock?.(); return { rowCount: 0, rows: [] }; }
      if (sql.includes("SELECT id, user_id FROM payments WHERE status='approved'")) {
        return store.approved && store.key === args[0]
          ? { rowCount: 1, rows: [{ id: 7, user_id: store.owner }] }
          : { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT * FROM payments WHERE user_id=")) {
        return store.approved ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: 7, amount: 5000 }] };
      }
      if (sql.includes("UPDATE payments")) {
        store.approved = true;
        store.key = JSON.parse(String(args[1])).receipt_key;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO subscriptions")) {
        store.count++;
        store.extensionDays += Number(args[1]);
        return { rowCount: 1, rows: [{ active_until: new Date(Date.now() + store.extensionDays * 86400_000) }] };
      }
      if (sql.includes("SELECT active_until FROM subscriptions")) {
        return { rowCount: 1, rows: [{ active_until: new Date(Date.now() + store.extensionDays * 86400_000) }] };
      }
      return { rowCount: 0, rows: [] };
    }
  }; });
  return { store, connect };
});
vi.mock("pg", () => ({ default: { Pool: class { connect = state.connect; } } }));
vi.mock("./config.js", () => ({ config: { DATABASE_URL: "postgres://localhost/test", SUBSCRIPTION_DAYS: 30 } }));
import { approvePaymentByVerifiedReceipt } from "./db.js";

const receipt = {
  receiptKey: "receipt:123:2026-09-24", url: "https://receipt.kaspi.kz/web?extTranId=123&sale_date=2026-09-24",
  amount: 5000, merchantBin: "770421401766", receiptDate: new Date()
};

describe("payment transaction idempotency", () => {
  beforeEach(() => {
    Object.assign(state.store, { approved: false, count: 0, extensionDays: 0, owner: 123,
      key: "", lock: Promise.resolve(), lastUserLockSql: "" });
  });
  it("two concurrent uploads approve once and add exactly 30 days", async () => {
    const results = await Promise.all([
      approvePaymentByVerifiedReceipt(123, receipt),
      approvePaymentByVerifiedReceipt(123, receipt)
    ]);
    expect(results.map(r => r.ok && r.newlyApproved)).toEqual([true, false]);
    expect(state.store.count).toBe(1);
    expect(state.store.extensionDays).toBe(30);
  });
  it("does not assign another user's receipt", async () => {
    await approvePaymentByVerifiedReceipt(123, receipt);
    expect(await approvePaymentByVerifiedReceipt(456, receipt)).toMatchObject({ ok: false, reason: "receipt_used" });
    expect(state.store.count).toBe(1);
  });
  it("hashes a Telegram user ID larger than PostgreSQL int32 before taking the lock", async () => {
    const userId = 6954213997;
    state.store.owner = userId;
    expect(await approvePaymentByVerifiedReceipt(userId, receipt)).toMatchObject({ ok: true });
    expect(state.store.lastUserLockSql).toContain("hashtext($2::text)");
  });
});
