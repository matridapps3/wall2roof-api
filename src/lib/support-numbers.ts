import { normalizeIndianMobile } from './auth.js';

/** What the owner types for "none": the number is removed (saved as ''). */
export const NO_NUMBER = '-';

const TYPED = /^[\d\s+-]+$/;
// a + only at the start, spaces and - only between digits ("+91 98140-12345", "0172 5012345")
const CALL = /^\+?\d+(?:[\s-]+\d+)*$/;

/**
 * The number customers call, kept as the owner typed it (spaces tidied): digits, spaces, + and -,
 * with 10 to 13 digits — a mobile, or a landline with its STD code. "-" = none (''); null = not valid.
 */
export function parseCallNumber(raw: string): string | null {
  const t = raw.trim();
  if (t === NO_NUMBER) return '';
  if (!CALL.test(t)) return null;
  const digits = t.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 13 ? t.replace(/\s+/g, ' ') : null;
}

/** The WhatsApp number: an Indian mobile, saved as its 10 digits. "-" = none (''); null = not valid. */
export function parseWhatsappNumber(raw: string): string | null {
  const t = raw.trim();
  if (t === NO_NUMBER) return '';
  return TYPED.test(t) ? normalizeIndianMobile(t) : null;
}
