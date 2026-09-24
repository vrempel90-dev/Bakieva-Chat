import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdf = vi.hoisted(() => ({ links: [] as string[], text: "" }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: pdf.text }] }),
        getAnnotations: async () => pdf.links.map(url => ({ url }))
      })
    }),
    destroy: async () => {}
  })
}));
import { verifyKaspiReceiptPdf } from "./receipt_verifier.js";

const forgedText = "Фискальный чек Kaspi ОФД ИИН/БИН продавца: 770421401766 Итого 5000 ₸ Дата и время: 24.09.2026 12:00 № чека: 123456 РНМ: 12345678 ФП: 987654";
const input = () => ({
  buffer: Buffer.from("%PDF-1.4 fake"), expectedAmount: 5000,
  expectedMerchantBin: "770421401766", maxAgeMinutes: 1440,
  paymentRequestedAt: new Date("2026-09-24T11:59:00+05:00")
});

describe("verified receipt boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:05:00+05:00"));
    pdf.text = forgedText;
    pdf.links = [];
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("does not approve editable PDF text without a verified official URL", async () => {
    const result = await verifyKaspiReceiptPdf(input());
    expect(result).toMatchObject({ ok: false, code: "receipt_id_unreadable" });
  });

  it("does not fall back to PDF text when Kaspi cannot be reached", async () => {
    pdf.links = ["https://receipt.kaspi.kz/web?extTranId=123&sale_date=2026-09-24"];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await verifyKaspiReceiptPdf(input())).toMatchObject({ ok: false, code: "fetch_failed" });
  });

  it("accepts matching data fetched from the official host", async () => {
    pdf.links = ["https://receipt.kaspi.kz/web?extTranId=123&sale_date=2026-09-24"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }),
      text: async () => `<html>${forgedText}</html>`
    }));
    expect(await verifyKaspiReceiptPdf(input())).toMatchObject({
      ok: true, receipt: { amount: 5000, merchantBin: "770421401766" }
    });
  });
});
