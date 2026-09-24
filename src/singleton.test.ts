import { describe, expect, it, vi } from "vitest";
import { acquireSingletonLock } from "./singleton.js";
import type { Pool } from "pg";

describe("poller singleton", () => {
  it("does not hand the lock to the next instance before the first releases it", async () => {
    let held = false;
    let releaseWait: (() => void) | undefined;
    const wait = vi.fn(() => new Promise<void>(resolve => { releaseWait = resolve; }));
    const pool = { connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql.includes("pg_try_advisory_lock")) {
          const locked = !held;
          if (locked) held = true;
          return { rows: [{ locked }] };
        }
        if (sql.includes("pg_advisory_unlock")) held = false;
        return { rows: [] };
      }),
      release: vi.fn()
    })) } as unknown as Pool;
    const signal = new AbortController().signal;
    const first = await acquireSingletonLock(pool, 834271, signal, wait);
    const secondPending = acquireSingletonLock(pool, 834271, signal, wait);
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    expect(held).toBe(true);
    await first.query("SELECT pg_advisory_unlock($1)", [834271]);
    first.release();
    releaseWait?.();
    const second = await secondPending;
    expect(second).not.toBe(first);
    expect(held).toBe(true);
    await second.query("SELECT pg_advisory_unlock($1)", [834271]);
    second.release();
  });
});
