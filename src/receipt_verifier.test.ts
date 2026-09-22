import { afterEach, describe, expect, it, vi } from "vitest";
import { validateReceiptFields } from "./receipt_verifier.js";

describe("Kaspi receipt timing", () => {
  afterEach(() => vi.useRealTimers());

  it("accepts a valid receipt paid earlier the same day before the bot payment session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:30:00+05:00"));

    const result = validateReceiptFields({
      amount: 5000,
      merchantBin: "770421401766",
      receiptDate: new Date("2026-09-22T01:33:00+05:00"),
      expectedAmount: 5000,
      expectedMerchantBin: "770421401766",
      maxAgeMinutes: 1440,
      paymentRequestedAt: new Date("2026-09-22T12:27:00+05:00")
    });

    expect(result).toBeNull();
  });

  it("still rejects a receipt outside the configured age window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:30:00+05:00"));

    const result = validateReceiptFields({
      amount: 5000,
      merchantBin: "770421401766",
      receiptDate: new Date("2026-09-21T10:00:00+05:00"),
      expectedAmount: 5000,
      expectedMerchantBin: "770421401766",
      maxAgeMinutes: 1440,
      paymentRequestedAt: new Date("2026-09-22T12:27:00+05:00")
    });

    expect(result).toMatchObject({ ok: false, code: "too_old" });
  });

  it("still rejects a future-dated receipt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:30:00+05:00"));

    const result = validateReceiptFields({
      amount: 5000,
      merchantBin: "770421401766",
      receiptDate: new Date("2026-09-22T13:00:00+05:00"),
      expectedAmount: 5000,
      expectedMerchantBin: "770421401766",
      maxAgeMinutes: 1440,
      paymentRequestedAt: new Date("2026-09-22T12:27:00+05:00")
    });

    expect(result).toMatchObject({ ok: false, code: "future_date" });
  });
});
