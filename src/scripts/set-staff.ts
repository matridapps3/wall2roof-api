/**
 * Make a teammate store staff ("Store orders" in the app), or a customer again. They log in once
 * in the app with their number first. Uses DATABASE_URL like the other scripts.
 *
 *   npm run staff:set -- 98xxxxxxxx staff
 *   npm run staff:set -- 98xxxxxxxx customer
 */
import { and, eq, isNull } from 'drizzle-orm';

import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { refreshTokens, users } from '../db/schema.js';
import { normalizeIndianMobile } from '../lib/auth.js';

/** Taking a role away (staff → customer, or an admin's) logs them out. */
const RANK = { customer: 0, staff: 1, admin: 2 } as const;

const [rawPhone, role] = process.argv.slice(2);
const phone = rawPhone ? normalizeIndianMobile(rawPhone) : null;
if (!phone || (role !== 'staff' && role !== 'customer')) {
  console.error('Usage: npm run staff:set -- <10-digit mobile> staff|customer');
  process.exit(1);
}

const { db, close } = await openDb();
const [u] = await db.select().from(users).where(eq(users.phone, phone));
if (!u || u.deletedAt) {
  console.error(`No account with ${phone}. Ask them to log in once in the app first, then run this again.`);
  await close();
  process.exit(1);
}
const who = `${phone} (${u.name ?? 'no name'})`;
if (u.role === role) {
  console.log(`${who} is already ${role}.`);
} else {
  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, u.id));
  if (RANK[role] < RANK[u.role]) {
    // the role sits in their login, so log them out on every phone; what they had ends with their current login
    await db.update(refreshTokens).set({ revokedAt: new Date() }).where(and(eq(refreshTokens.userId, u.id), isNull(refreshTokens.revokedAt)));
    console.log(`${who} is now ${role} and has been logged out. Their ${u.role} access ends within ${config.ACCESS_TOKEN_TTL_MIN} minutes.`);
  } else {
    console.log(`${who} is now staff. They see "Store orders" after logging out and in again (or within ${config.ACCESS_TOKEN_TTL_MIN} minutes).`);
  }
}
await close();
