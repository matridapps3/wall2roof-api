/**
 * The admin app's first owner, or a forgotten password: creates an owner account, or, when the
 * username already exists, resets its password (and makes it an active, unlocked owner, logged out of
 * every phone). Uses DATABASE_URL like the other scripts, but never migrates it: the live database
 * gets the admin app's tables when the server with the admin app is deployed, so deploy that first
 * (otherwise this stops and changes nothing). Migrating from here would apply whatever migrations
 * this computer has that aren't released yet.
 *
 * Reads STAFF_USERNAME, STAFF_NAME and STAFF_PASSWORD from the environment, so the password never
 * appears in the list of running programs. "Create ElectroDash admin owner.cmd" on the Desktop asks
 * for them and runs this.
 *
 *   npm run staff:owner
 */
import { eq, sql } from 'drizzle-orm';

import { config } from '../config.js';
import { openDb } from '../db/client.js';
import { staffAccounts } from '../db/schema.js';
import { hashPassword } from '../lib/auth.js';
import { logOutStaff, validateOwnerInput } from '../lib/staff-accounts.js';

const input = validateOwnerInput(process.env);
if (!input.ok) {
  for (const e of input.errors) console.error(e);
  console.error('Nothing was changed.');
  process.exit(1);
}
const { username, name, password } = input.value;

const passwordHash = await hashPassword(password);
const { db, close } = await openDb({ migrate: false });
try {
  const found = await db.execute<{ ready: boolean }>(sql`select to_regclass('public.staff_accounts') is not null as ready`);
  if (!found.rows[0]?.ready) {
    console.error('The live database has no admin app accounts table yet: deploy the server with the admin app first (it sets the table up), then run this again.');
    console.error('Nothing was changed.');
    process.exitCode = 1;
  } else {
    const [existing] = await db.select().from(staffAccounts).where(eq(staffAccounts.username, username));
    if (existing) {
      await db.transaction(async (tx) => {
        await tx
          .update(staffAccounts)
          .set({ name, passwordHash, role: 'owner', active: true, failedLogins: 0, lockedUntil: null, updatedAt: new Date() })
          .where(eq(staffAccounts.id, existing.id));
        await logOutStaff(tx, existing.id, { pushTokens: true });
      });
      console.log(`Reset the password of "${username}" (${name}). It is an active owner and was logged out of every phone.`);
    } else {
      await db.insert(staffAccounts).values({ username, name, passwordHash, role: 'owner' });
      console.log(`Created the owner "${username}" (${name}).`);
    }
    console.log('Log in to the ElectroDash admin app with this username and the password you typed.');
    if (!config.DATABASE_URL) console.log(`(No DATABASE_URL, so this went to the local database in ${config.PGLITE_DIR}, not the live server.)`);
  }
} finally {
  await close();
}
