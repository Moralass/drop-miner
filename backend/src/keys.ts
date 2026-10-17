import { createHmac, randomBytes } from "node:crypto";

// Алфавит Crockford base32: без I, L, O, U — их нельзя перепутать с 1 и 0 при вводе вручную.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 16; // 16 × 5 бит = 80 бит энтропии — перебор невозможен
const PREFIX = "DM";
const LEGACY_PREFIX = "DD"; // ключи с прежним префиксом продолжают приниматься

/** Новый ключ вида DM-XXXX-XXXX-XXXX-XXXX. */
export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  // 256 делится на 32 нацело, поэтому `& 31` не даёт перекоса в распределении.
  const raw = Array.from(bytes, (b) => ALPHABET[b & 31]).join("");
  return `${PREFIX}-${raw.match(/.{4}/g)!.join("-")}`;
}

/**
 * Приводит ввод пользователя к каноническому виду (16 символов алфавита) или возвращает null.
 * Прощает регистр, пробелы, дефисы, префиксы DM/DD и путаницу O/0, I/L/1.
 */
export function normalizeCode(input: string): string | null {
  let s = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.length === CODE_LENGTH + PREFIX.length && (s.startsWith(PREFIX) || s.startsWith(LEGACY_PREFIX))) s = s.slice(PREFIX.length);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export function hashCode(normalized: string): string {
  const pepper = process.env.KEY_PEPPER;
  if (!pepper || pepper.length < 16) throw new Error("KEY_PEPPER must be set (16+ chars)");
  return createHmac("sha256", pepper).update(normalized).digest("hex");
}

export function hintOf(normalized: string): string {
  return normalized.slice(-4);
}
