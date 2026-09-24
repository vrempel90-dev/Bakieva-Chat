import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QRCode from "qrcode";
import { loadImage } from "@napi-rs/canvas";

const pdf = vi.hoisted(() => ({ links: [] as string[], text: "", qrPng: "" }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({ items: [{ str: pdf.text }] }),
        getAnnotations: async () => pdf.links.map(url => ({ url })),
        getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 400 * scale }),
        render: ({ canvasContext, viewport }: { canvasContext: CanvasRenderingContext2D;
          viewport: { width: number; height: number } }) => ({ promise: (async () => {
          if (!pdf.qrPng) return;
          const img = await loadImage(Buffer.from(pdf.qrPng.split(",")[1], "base64"));
          canvasContext.drawImage(img as unknown as CanvasImageSource, 0, 0, viewport.width, viewport.height);
        })() })
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
    pdf.qrPng = "";
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("accepts a PDF without clickable QR after validating receipt fields", async () => {
    expect(await verifyKaspiReceiptPdf(input())).toMatchObject({
      ok: true, receipt: { amount: 5000, merchantBin: "770421401766",
        receiptKey: "pdf:123456:12345678:987654" }
    });
  });

  it("accepts a valid PDF when Kaspi is temporarily unreachable", async () => {
    pdf.links = ["https://receipt.kaspi.kz/web?extTranId=123&sale_date=2026-09-24"];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await verifyKaspiReceiptPdf(input())).toMatchObject({ ok: true, receipt: { amount: 5000 } });
  });

  it("rejects a PDF with a mismatched merchant even if the layout looks genuine", async () => {
    pdf.text = forgedText.replace("770421401766", "999999999999");
    expect(await verifyKaspiReceiptPdf(input())).toMatchObject({ ok: false, code: "merchant_mismatch" });
  });

  it("routes an incomplete PDF for review rather than activating a subscription", async () => {
    pdf.text = forgedText.replace("РНМ: 12345678", "");
    expect(await verifyKaspiReceiptPdf(input())).toMatchObject({ ok: false, code: "receipt_id_unreadable" });
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

  it("decodes the QR painted in a PDF without clickable links before verifying online", async () => {
    pdf.qrPng = await QRCode.toDataURL("https://receipt.kaspi.kz/web?extTranId=123&sale_date=2026-09-24",
      { width: 400, margin: 4 });
    const online = vi.fn().mockResolvedValue({ ok: true, status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => `<html>${forgedText}</html>` });
    vi.stubGlobal("fetch", online);
    expect(await verifyKaspiReceiptPdf(input())).toMatchObject({
      ok: true, receipt: { amount: 5000, merchantBin: "770421401766" }
    });
    expect(online).toHaveBeenCalledOnce();
  });
});
