import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

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
        | "invalid_pdf"
        | "pdf_unreadable"
        | "not_fiscal"
        | "amount_unreadable"
        | "amount_mismatch"
        | "merchant_unreadable"
        | "merchant_not_configured"
        | "merchant_mismatch"
        | "date_unreadable"
        | "receipt_id_unreadable"
        | "fetch_failed"
        | "before_payment_session"
        | "future_date"
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

function normalizeText(value: string) {
  return value
    .replace(/\u00a0/g, " ")
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

    if (url.pathname === "/api/v3/receipt/download") {
      const extTranId = url.searchParams.get("extTranId");
      const saleDate = url.searchParams.get("sale_date");
      if (!extTranId || !saleDate) return null;

      const pageUrl = new URL("/web", url.origin);
      pageUrl.searchParams.set("extTranId", extTranId);
      pageUrl.searchParams.set("sale_date", saleDate);
      return pageUrl;
    }

    if (!RECEIPT_PATHS.has(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

function extractOfficialReceiptUrl(text: string) {
  const matches = text.match(/https:\/\/receipt\.kaspi\.kz\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    const url = normalizeOfficialReceiptUrl(raw);
    if (url) return url;
  }
  return null;
}

async function fetchOfficialReceipt(url: URL) {
  let current = url;
  for (let i = 0; i < 3; i++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(8_000),
      headers: {
        "user-agent": "BakievaChatReceiptVerifier/2.0",
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

function amountFromText(text: string) {
  const match = text.match(
    /(?:Платеж\s+успешно\s+совершен|Оплата\s+совершена|Сумма\s+оплаты|Итого)[^\d]{0,100}([\d\s\u00a0]+(?:[.,]\d{1,2})?)\s*₸/i
  );
  return match ? parseMoney(match[1]) : null;
}

function amountFromUrlOrText(url: URL, text: string) {
  if (url.pathname === "/web/fiscal") {
    const raw = url.searchParams.get("s");
    if (raw) return parseMoney(raw);
  }
  return amountFromText(text);
}

function merchantBinFromText(text: string) {
  const match = text.match(/ИИН\s*\/\s*БИН\s+продавца\s*[:—-]?\s*(\d{12})/i);
  return match?.[1] ?? null;
}

function receiptDateFromText(text: string) {
  const match = text.match(
    /Дата\s+и\s+время(?:\s+по\s+Астане)?\s*[:—-]?\s*(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/i
  );
  if (!match) return null;

  const [, day, month, year, hour, minute, second = "00"] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+05:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function receiptNumberFromText(text: string) {
  const match = text.match(/№\s*чека\s*[:—-]?\s*([A-ZА-Я0-9_-]{3,80})/i);
  return match?.[1] ?? null;
}

function rnmFromText(text: string) {
  const match = text.match(/РНМ\s*[:—-]?\s*([A-ZА-Я0-9_-]{6,80})/i);
  return match?.[1] ?? null;
}

function fiscalSignFromText(text: string) {
  const match = text.match(/(?:^|\s)ФП\s*[:—-]?\s*([A-ZА-Я0-9_-]{4,80})/im);
  return match?.[1] ?? null;
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

export function validateReceiptFields(input: {
  amount: number | null;
  merchantBin: string | null;
  receiptDate: Date | null;
  expectedAmount: number;
  expectedMerchantBin?: string;
  maxAgeMinutes: number;
  paymentRequestedAt: Date;
}): ReceiptVerificationResult | null {
  if (input.amount === null) {
    return {
      ok: false,
      code: "amount_unreadable",
      message: "Не удалось надёжно определить сумму в PDF-чеке."
    };
  }
  if (input.amount !== input.expectedAmount) {
    return {
      ok: false,
      code: "amount_mismatch",
      message: `Сумма в чеке ${input.amount.toLocaleString("ru-RU")} ₸, а подписка стоит ${input.expectedAmount.toLocaleString("ru-RU")} ₸.`
    };
  }

  if (!input.merchantBin) {
    return {
      ok: false,
      code: "merchant_unreadable",
      message: "Не удалось определить ИИН/БИН продавца в PDF-чеке."
    };
  }
  if (!input.expectedMerchantBin) {
    return {
      ok: false,
      code: "merchant_not_configured",
      message: "Автоматическая проверка получателя ещё не настроена."
    };
  }
  if (input.merchantBin !== input.expectedMerchantBin) {
    return {
      ok: false,
      code: "merchant_mismatch",
      message: "Этот чек выписан другим продавцом и не относится к Bakieva Chat."
    };
  }

  if (!input.receiptDate) {
    return {
      ok: false,
      code: "date_unreadable",
      message: "Не удалось определить дату и время платежа в PDF-чеке."
    };
  }

  const now = Date.now();
  const paidAt = input.receiptDate.getTime();
  const clockSkewMs = 10 * 60_000;
  const maxAgeMs = input.maxAgeMinutes * 60_000;

  if (paidAt > now + clockSkewMs) {
    return {
      ok: false,
      code: "future_date",
      message: "Дата или время чека некорректны: платёж указан в будущем."
    };
  }

  if (now - paidAt > maxAgeMs) {
    return {
      ok: false,
      code: "too_old",
      message: "Срок проверки этого чека истёк. Отправьте PDF-чек текущей оплаты."
    };
  }

  return null;
}

async function verifyKaspiReceiptUrl(input: {
  url: URL;
  expectedAmount: number;
  expectedMerchantBin?: string;
  maxAgeMinutes: number;
  paymentRequestedAt: Date;
}): Promise<ReceiptVerificationResult> {
  let html: string;
  let finalUrl: URL;
  try {
    const fetched = await fetchOfficialReceipt(input.url);
    html = fetched.html;
    finalUrl = fetched.finalUrl;
  } catch {
    return {
      ok: false,
      code: "fetch_failed",
      message: "Не удалось проверить чек на официальной странице Kaspi. Попробуйте отправить PDF ещё раз."
    };
  }

  const text = htmlToText(html);
  if (!/Фискальный\s+чек/i.test(text) || !/Kaspi\s*ОФД/i.test(text)) {
    return {
      ok: false,
      code: "not_fiscal",
      message: "Документ не подтверждён как фискальный чек Kaspi ОФД."
    };
  }

  const amount = amountFromUrlOrText(finalUrl, text);
  const merchantBin = merchantBinFromText(text);
  const receiptDate = receiptDateFromText(text);
  const error = validateReceiptFields({
    amount,
    merchantBin,
    receiptDate,
    expectedAmount: input.expectedAmount,
    expectedMerchantBin: input.expectedMerchantBin,
    maxAgeMinutes: input.maxAgeMinutes,
    paymentRequestedAt: input.paymentRequestedAt
  });
  if (error) return error;

  return {
    ok: true,
    receipt: {
      receiptKey: receiptKeyFromUrl(finalUrl),
      url: finalUrl.toString(),
      amount: amount!,
      merchantBin: merchantBin!,
      receiptDate
    }
  };
}

async function extractPdfTextAndLinks(buffer: Buffer) {
  if (buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("Not a PDF");
  }

  const loadingTask = getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  try {
    const parts: string[] = [];
    const links: string[] = [];
    const pageCount = Math.min(pdf.numPages, 5);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      for (const item of textContent.items) {
        const candidate = item as { str?: string; hasEOL?: boolean };
        if (candidate.str) parts.push(candidate.str);
        parts.push(candidate.hasEOL ? "\n" : " ");
      }

      const annotations = await page.getAnnotations();
      for (const annotation of annotations as Array<{ url?: string; unsafeUrl?: string }>) {
        const raw = annotation.url ?? annotation.unsafeUrl;
        if (raw) links.push(raw);
      }
      parts.push("\n");
    }

    return {
      text: normalizeText(parts.join("")),
      links
    };
  } finally {
    await loadingTask.destroy();
  }
}

export async function verifyKaspiReceiptPdf(input: {
  buffer: Buffer;
  expectedAmount: number;
  expectedMerchantBin?: string;
  maxAgeMinutes: number;
  paymentRequestedAt: Date;
}): Promise<ReceiptVerificationResult> {
  let parsed: { text: string; links: string[] };
  try {
    parsed = await extractPdfTextAndLinks(input.buffer);
  } catch {
    return {
      ok: false,
      code: "invalid_pdf",
      message: "Не удалось открыть документ как PDF. Скачайте фискальный чек Kaspi в формате PDF и отправьте файл без изменений."
    };
  }

  if (!parsed.text) {
    return {
      ok: false,
      code: "pdf_unreadable",
      message: "В PDF не удалось прочитать текст чека. Скачайте исходный фискальный чек Kaspi и отправьте его как документ."
    };
  }

  const officialUrl =
    parsed.links.map(normalizeOfficialReceiptUrl).find((value): value is URL => Boolean(value)) ??
    extractOfficialReceiptUrl(parsed.text);

  if (officialUrl) {
    const online = await verifyKaspiReceiptUrl({
      url: officialUrl,
      expectedAmount: input.expectedAmount,
      expectedMerchantBin: input.expectedMerchantBin,
      maxAgeMinutes: input.maxAgeMinutes,
      paymentRequestedAt: input.paymentRequestedAt
    });
    if (online.ok) return online;
    if (online.code !== "fetch_failed") return online;
  }

  const text = parsed.text;
  if (!/Фискальный\s+чек/i.test(text) || !/Kaspi\s*ОФД/i.test(text)) {
    return {
      ok: false,
      code: "not_fiscal",
      message: "В PDF не найден фискальный чек Kaspi ОФД."
    };
  }

  const amount = amountFromText(text);
  const merchantBin = merchantBinFromText(text);
  const receiptDate = receiptDateFromText(text);
  const error = validateReceiptFields({
    amount,
    merchantBin,
    receiptDate,
    expectedAmount: input.expectedAmount,
    expectedMerchantBin: input.expectedMerchantBin,
    maxAgeMinutes: input.maxAgeMinutes,
    paymentRequestedAt: input.paymentRequestedAt
  });
  if (error) return error;

  const receiptNumber = receiptNumberFromText(text);
  const rnm = rnmFromText(text);
  const fiscalSign = fiscalSignFromText(text);
  if (!receiptNumber || !rnm || !fiscalSign) {
    return {
      ok: false,
      code: "receipt_id_unreadable",
      message: "Не удалось прочитать номер чека, РНМ или фискальный признак. Отправьте исходный PDF-чек Kaspi."
    };
  }

  return {
    ok: true,
    receipt: {
      receiptKey: `pdf:${receiptNumber}:${rnm}:${fiscalSign}`,
      url: `pdf://kaspi/${encodeURIComponent(receiptNumber)}`,
      amount: amount!,
      merchantBin: merchantBin!,
      receiptDate
    }
  };
}
