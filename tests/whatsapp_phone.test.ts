import { describe, expect, it } from "vitest";
import { normalizeWhatsAppPhone } from "../src/whatsapp_phone.js";

describe("WhatsApp number normalization", () => {
  it("accepts E.164 numbers with punctuation", () => {
    expect(normalizeWhatsAppPhone("+7 (700) 123-45-67")).toBe("+77001234567");
    expect(normalizeWhatsAppPhone("+447700900123")).toBe("+447700900123");
  });
  it("converts unambiguous Kazakhstan and Russian formats", () => {
    expect(normalizeWhatsAppPhone("87001234567")).toBe("+77001234567");
    expect(normalizeWhatsAppPhone("77001234567")).toBe("+77001234567");
  });
  it("rejects unrelated text, national-only and invalid numbers", () => {
    expect(normalizeWhatsAppPhone("hello")).toBeNull();
    expect(normalizeWhatsAppPhone("7001234567")).toBeNull();
    expect(normalizeWhatsAppPhone("+123")).toBeNull();
    expect(normalizeWhatsAppPhone("+1234567890123456")).toBeNull();
    expect(normalizeWhatsAppPhone("+12345abc12345")).toBeNull();
  });
});
