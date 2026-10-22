import { UserError } from "./errors.js";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export function normalizePhone(input: string): string | null {
  if (input.length > 50 || !/^[+\d\s().-]+$/.test(input)) return null;
  const compact = input.replace(/[\s().-]/g, "");
  // KZ local forms are accepted; other countries must include their calling code.
  const raw = /^8\d{10}$/.test(compact)
    ? "+7" + compact.slice(1)
    : /^7\d{10}$/.test(compact)
      ? "+" + compact
      : compact;
  const phone = parsePhoneNumberFromString(raw, "KZ");
  return phone?.isValid() ? phone.number : null;
}
