import { GrammyError } from "grammy";
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}
export function publicError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (error instanceof GrammyError)
    return `Telegram ${error.error_code}: ${error.description.replace(/\b\d{6,}:[A-Za-z0-9_-]{10,}\b/g, "[секрет скрыт]").slice(0, 180)}`;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    /^[A-Z0-9]{5}$/.test(String(error.code))
  )
    return `Ошибка базы данных (${String(error.code)}). Обратитесь в поддержку.`;
  if (
    error &&
    typeof error === "object" &&
    "errorMessage" in error &&
    /^[A-Z0-9_]{3,80}$/.test(String(error.errorMessage))
  )
    return `Telegram MTProto: ${String(error.errorMessage)}`;
  return "Ошибка сети, базы данных или прав доступа. Проверьте подключение и права бота; повторите действие позже.";
}
