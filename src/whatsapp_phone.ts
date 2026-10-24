/**
 * Require an international number or the unambiguous RU/KZ +7 convention.
 * Never infer a country from an arbitrary 10-digit local number.
 */
export function normalizeWhatsAppPhone(value: string): string | null {
  const input = value.trim();
  if (!/^\+?[\d\s().-]+$/.test(input)) return null;
  let digits = input.replace(/\D/g, "");
  if (/^8\d{10}$/.test(digits) && !input.startsWith("+")) {
    digits = "7" + digits.slice(1);
  } else if (!input.startsWith("+") && !/^7\d{10}$/.test(digits)) {
    return null;
  }
  if (digits.length < 10 || digits.length > 15 || digits.startsWith("0")) return null;
  return "+" + digits;
}
