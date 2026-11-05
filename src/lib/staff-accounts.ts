import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { staffPushTokens, staffSessions } from '../db/schema.js';

/**
 * The admin app's accounts (staff_accounts): the rules for usernames, names and passwords, shared by
 * the team screens (/v1/staff/team) and `npm run staff:owner`.
 */

export const USERNAME_RULE = 'Use 3 to 32 lower-case letters, numbers, dots, dashes or underscores';
export const STAFF_PASSWORD_RULE = 'Use at least 8 characters';

/** Typed in any case ("Meena.K"), kept lower-case ("meena.k"). */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, USERNAME_RULE);
export const staffNameSchema = z.string().trim().min(1, 'Enter the name').max(80, 'Use at most 80 characters');
export const staffPasswordSchema = z.string().min(8, STAFF_PASSWORD_RULE).max(128, 'Use at most 128 characters');
export const staffRoleSchema = z.enum(['owner', 'staff']);

/** What expo-notifications' getExpoPushTokenAsync() gives: ExponentPushToken[…] (older: ExpoPushToken[…]). */
export const expoPushTokenSchema = z
  .string()
  .trim()
  .max(200)
  .regex(/^Expo(nent)?PushToken\[[^\]\s]+\]$/, 'Not an Expo push token');

export type OwnerInput = { username: string; name: string; password: string };

/**
 * `npm run staff:owner`'s input, from STAFF_USERNAME, STAFF_NAME and STAFF_PASSWORD (environment
 * variables, so the password never shows in the list of running programs). The messages name the
 * questions "Create ElectroDash admin owner.cmd" asks.
 */
export function validateOwnerInput(env: Record<string, string | undefined>): { ok: true; value: OwnerInput } | { ok: false; errors: string[] } {
  const fields: [keyof OwnerInput, string, string, z.ZodType<string>][] = [
    ['username', 'STAFF_USERNAME', 'Username', usernameSchema],
    ['name', 'STAFF_NAME', 'Full name', staffNameSchema],
    ['password', 'STAFF_PASSWORD', 'Password', staffPasswordSchema],
  ];
  const errors: string[] = [];
  const value: Partial<OwnerInput> = {};
  for (const [key, envName, label, schema] of fields) {
    const raw = env[envName];
    if (raw === undefined || raw.trim() === '') {
      errors.push(`${label} is missing (${envName}).`);
      continue;
    }
    const r = schema.safeParse(raw);
    if (r.success) value[key] = r.data;
    else errors.push(`${label}: ${r.error.issues[0]?.message ?? 'not valid'}.`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: value as OwnerInput };
}

/**
 * Logs a staff member out of the admin app (every login but `keepSessionId`). With `pushTokens`, their
 * phones also stop getting new-order alerts.
 */
export async function logOutStaff(db: Pick<Db, 'update' | 'delete'>, staffId: number, opts: { keepSessionId?: number; pushTokens?: boolean } = {}) {
  await db
    .update(staffSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(staffSessions.staffId, staffId),
        isNull(staffSessions.revokedAt),
        opts.keepSessionId ? ne(staffSessions.id, opts.keepSessionId) : undefined,
      ),
    );
  if (opts.pushTokens) await db.delete(staffPushTokens).where(eq(staffPushTokens.staffId, staffId));
}
