import jsQR from "jsqr";
import sharp from "sharp";

const RECEIPT_HOST = "receipt.kaspi.kz";
const RECEIPT_PATHS = new Set(["/web", "/web/fiscal"]);

export type VerifiedKaspiReceipt = {
  receiptKey: string;
  url: string;
  amount: number;
  merchantBin: string;
  receiptDate: Date | null;
};

export type ReceiptVerificationResult =
  | { ok: true; receipt: VerifiedKaspiReceipt }
  | {
      ok: false;
      code:
        | "invalid_url"
        | "not_official"
        | "fetch_failed"
        | "not_fiscal"
        | "amount_unreadable"
        | "amount_mismatch"
        | "merchant_unreadable"
        | "merchant_not_configured"
        | "merchant_mismatch"
        | "too_old";
      message: string;
    };

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x20b8;/gi, "₸")
    .replace(/&#8376;/gi, "₸");
}

function htmlToText(html: string) {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMoney(value: string) {
  const normalized = value.replace(/[\s\u00a0]/g, "").replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function normalizeOfficialReceiptUrl(raw: string) {
  try {
    const cleaned = raw.trim().replace(/[),.;]+$/, "");
    const url = new URL(cleaned);
    if (url.protocol !== "https:" || url.hostname !== RECEIPT_HOST) return null;
    if (!RECEIPT_PATHS.has(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function extractKaspiReceiptUrl(text: string) {
  const match = text.match(/https:\/\/receipt\.kaspi\.kz\/[^\s<>"']+/i);
  if (!match) return null;
  const url = normalizeOfficialReceiptUrl(match[0]);
  return url?.toString() ?? null;
}

export async function extractKaspiReceiptUrlFromImage(buffer: Buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) return null;
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
  const decoded = jsQR(pixels, info.width, info.height, { inversionAttempts: "attemptBoth" });
  if (!decoded?.data) return null;
  const url = normalizeOfficialReceiptUrl(decoded.data);
  return url?.toString() ?? null;
}

async function fetchOfficialReceipt(url: URL) {
  let current = url;
  for (let i = 0; i < 3; i++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "user-agent": "BakievaChatReceiptVerifier/1.0",
        accept: "text/html,application/xhtml+xml"
      }
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect without location");
      const next = new URL(location, current);
      if (next.protocol !== "https:" || next.hostname !== RECEIPT_HOST) {
        throw new Error("Unsafe receipt redirect");
      }
      current = next;
      continue;
    }

    if (!response.ok) throw new Error(`Kaspi receipt HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) throw new Error("Unexpected receipt content type");

    const html = await response.text();
    if (html.length > 2_000_000) throw new Error("Receipt page too large");
    return { html, finalUrl: current };
  }
  throw new Error("Too many redirects");
}

function amountFromUrlOrText(url: URL, text: string) {
  if (url.pathname === "/web/fiscal") {
    const raw = url.searchParams.get("s");
    if (raw) return parseMoney(raw);
  }

  const match = text.match(
    /(?:Платеж успешно совершен|Оплата совершена|Сумма оплаты|Итого)[^\d]{0,80}([\d\s\u00a0]+(?:[.,]\d{1,2})?)\s*₸/i
  );
  return match ? parseMoney(match[1]) : null;
}

function merchantBinFromText(text: string) {
  const match = text.match(/ИИН\s*\/\s*БИН\s+продавца\s*[:—-]?\s*(\d{12})/i);
  return match?.[1] ?? null;
}

function receiptDateFromUrl(url: URL) {
  const raw = url.searchParams.get("t") ?? url.searchParams.get("sale_date");
  if (!raw) return null;

  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const isoLike = raw.includes("T") ? raw : raw.replace(" ", "T");
  const candidate = hasZone ? isoLike : `${isoLike}+05:00`;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function receiptKeyFromUrl(url: URL) {
  if (url.pathname === "/web/fiscal") {
    const f = url.searchParams.get("f");
    const i = url.searchParams.get("i");
    const s = url.searchParams.get("s");
    const t = url.searchParams.get("t");
    if (f && i && s && t) return `fiscal:${f}:${i}:${s}:${t}`;
  }

  const ext = url.searchParams.get("extTranId");
  const saleDate = url.searchParams.get("sale_date");
  if (ext && saleDate) return `receipt:${ext}:${saleDate}`;
  return `url:${url.toString()}`;
}

export async function verifyKaspiReceipt(input: {
  url: string;
  expectedAmount: number;
  expectedMerchantBin?: string;
  maxAgeMinutes: number;
}): Promise<ReceiptVerificationResult> {
  const url = normalizeOfficialReceiptUrl(input.url);
  if (!url) {
    return { ok: false, code: "invalid_url", message: "Не удалось распознать официальный чек Kaspi." };
  }

  if (url.hostname !== RECEIPT_HOST) {
    return { ok: false, code: "not_official", message: "Чек должен открываться на официальном домене Kaspi." };
  }

  let html: string;
  let finalUrl: URL;
  try {
    const fetched = await fetchOfficialReceipt(url);
    html = fetched.html;
    finalUrl = fetched.finalUrl;
  } catch {
    return { ok: false, code: "fetch_failed", message: "Не удалось проверить чек на стороне Kaspi. Попробуйте ещё раз." };
  }

  const text = htmlToText(html);
  if (!/Фискальный чек/i.test(text) || !/Kaspi\s*ОФД/i.test(text)) {
    return { ok: false, code: "not_fiscal", message: "Это не подтверждённый фискальный чек Kaspi ОФД." };
  }

  const amount = amountFromUrlOrText(finalUrl, text);
  if (amount === null) {
    return {
      ok: false,
      code: "amount_unreadable",
      message: "Не удалось надёжно определить сумму. Отправьте фото чека целиком, чтобы был виден QR-код."
    };
  }
  if (amount !== input.expectedAmount) {
    return {
      ok: false,
      code: "amount_mismatch",
      message: `Сумма в чеке ${amount.toLocaleString("ru-RU")} ₸, а подписка стоит ${input.expectedAmount.toLocaleString("ru-RU")} ₸.`
    };
  }

  const merchantBin = merchantBinFromText(text);
  if (!merchantBin) {
    return { ok: false, code: "merchant_unreadable", message: "Не удалось определить ИИН/БИН продавца в чеке." };
  }
  if (!input.expectedMerchantBin) {
    return {
      ok: false,
      code: "merchant_not_configured",
      message: "Автоматическая проверка получателя ещё не настроена."
    };
  }
  if (merchantBin !== input.expectedMerchantBin) {
    return {
      ok: false,
      code: "merchant_mismatch",
      message: "Этот чек выписан другим продавцом и не относится к Bakieva Chat."
    };
  }

  const receiptDate = receiptDateFromUrl(finalUrl);
  if (receiptDate) {
    const ageMs = Date.now() - receiptDate.getTime();
    const maxAgeMs = input.maxAgeMinutes * 60_000;
    if (ageMs < -10 * 60_000 || ageMs > maxAgeMs) {
      return {
        ok: false,
        code: "too_old",
        message: "Этот чек не относится к текущей оплате. Отправьте чек последнего платежа."
      };
    }
  }

  return {
    ok: true,
    receipt: {
      receiptKey: receiptKeyFromUrl(finalUrl),
      url: finalUrl.toString(),
      amount,
      merchantBin,
      receiptDate
    }
  };
}
