import { randomBytes } from 'node:crypto';

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { orderItems, orders, staffAccounts, staffPushTokens, staffSessions, users } from '../db/schema.js';
import { HttpError, idParam, parse } from '../http.js';
import { hashPassword, newRefreshToken, sha256, signStaffAccessToken, verifyPassword, verifyStaffAccessToken } from '../lib/auth.js';
import {
  expoPushTokenSchema,
  logOutStaff,
  staffNameSchema,
  staffPasswordSchema,
  staffRoleSchema,
  usernameSchema,
} from '../lib/staff-accounts.js';
import { changeOrderStatus, loadStoreOrder } from './orders.js';

/**
 * The admin app: teammates log in with their own username and password (staff_accounts, not customer
 * accounts), get a push for each new order and mark orders picked, packed, dispatched and delivered.
 * Owners also manage the team. The app names the steps its own way (New, Picked, Packed, Dispatched);
 * the statuses here, and what customers see, stay as they are.
 *
 * Its tokens say `typ: 'staff'`: a customer login gets 401 on every route here, and an admin app
 * login gets 401 on every customer route. Each request also checks the login (staff_sessions row) and
 * the account are still live, so logging out, a password reset or deactivation takes effect at once.
 */

type StaffRow = typeof staffAccounts.$inferSelect;
type Me = StaffRow & { sessionId: number };
type OrderRow = typeof orders.$inferSelect;

/** How long an admin app login lasts without opening the app; every refresh starts the count again. */
export const STAFF_REFRESH_TTL_DAYS = 90;
/** Wrong passwords in a row that lock the account, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

const STATUSES = ['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled'] as const;
/** Orders still to be sent out or delivered (the default list). */
const ACTIVE = ['placed', 'confirmed', 'packed', 'out_for_delivery'] as const;

// Same message for an unknown username, a wrong password and a deactivated account.
const badCredentials = () => new HttpError(401, 'bad_credentials', 'Username or password is incorrect.');
const sessionExpired = () => new HttpError(401, 'session_expired', 'Your session has expired. Please log in again.');
const locked = (until: Date) => {
  const min = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return new HttpError(429, 'locked', `Too many wrong passwords. Try again in ${min} minute${min === 1 ? '' : 's'}.`);
};

// A real bcrypt hash of a random password: an unknown username takes as long to answer as a wrong password.
let dummyHash: Promise<string> | null = null;
const dummy = () => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

/** Not locked by wrong passwords (or the lock is over). */
const unlocked = (now: Date) => or(isNull(staffAccounts.lockedUntil), lte(staffAccounts.lockedUntil, now));

async function lockedError(db: Db, staffId: number) {
  const [s] = await db.select({ lockedUntil: staffAccounts.lockedUntil }).from(staffAccounts).where(eq(staffAccounts.id, staffId));
  return locked(s?.lockedUntil && s.lockedUntil > new Date() ? s.lockedUntil : new Date(Date.now() + LOCK_MINUTES * 60_000));
}

async function lock(db: Db, staffId: number) {
  // the count starts again once the lock is over
  const until = new Date(Date.now() + LOCK_MINUTES * 60_000);
  await db.update(staffAccounts).set({ failedLogins: 0, lockedUntil: until }).where(eq(staffAccounts.id, staffId));
  return locked(until);
}

/**
 * Checks a staff member's password (logging in, or the current one when changing it) against the lock.
 * The attempt is used up in the database before the slow check, in one statement, so guesses sent all
 * at once can't get past the lock: at most MAX_FAILED_LOGINS passwords are checked, then the account is
 * locked for LOCK_MINUTES and answers 429 without checking. A right password clears the count, unless
 * guesses sent meanwhile locked the account. Returns the account as updated (with `also`).
 */
async function checkPassword(db: Db, s: StaffRow, password: string, wrong: () => HttpError, also: { lastLoginAt?: Date } = {}): Promise<StaffRow> {
  const [attempt] = await db
    .update(staffAccounts)
    .set({ failedLogins: sql`${staffAccounts.failedLogins} + 1` })
    .where(and(eq(staffAccounts.id, s.id), unlocked(new Date())))
    .returning({ n: staffAccounts.failedLogins });
  if (!attempt) throw await lockedError(db, s.id);
  if (attempt.n > MAX_FAILED_LOGINS) throw await lock(db, s.id);
  if (!(await verifyPassword(password, s.passwordHash))) {
    throw attempt.n >= MAX_FAILED_LOGINS ? await lock(db, s.id) : wrong();
  }
  const [fresh] = await db
    .update(staffAccounts)
    .set({ failedLogins: 0, lockedUntil: null, ...also })
    .where(and(eq(staffAccounts.id, s.id), unlocked(new Date())))
    .returning();
  if (!fresh) throw await lockedError(db, s.id);
  return fresh;
}

export function publicStaff(s: StaffRow) {
  return { id: s.id, name: s.name, username: s.username, role: s.role };
}

function teamMember(s: StaffRow) {
  return {
    ...publicStaff(s),
    active: s.active,
    lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

async function createSession(db: Db, s: StaffRow) {
  const { token, hash } = newRefreshToken();
  const [row] = await db
    .insert(staffSessions)
    .values({ staffId: s.id, tokenHash: hash, expiresAt: new Date(Date.now() + STAFF_REFRESH_TTL_DAYS * 86_400_000) })
    .returning({ id: staffSessions.id });
  return {
    refreshId: row.id,
    session: {
      accessToken: await signStaffAccessToken({ staffId: s.id, role: s.role, sessionId: row.id }),
      refreshToken: token,
      staff: publicStaff(s),
    },
  };
}

/** The logged-in staff member: a valid admin app token whose login and account are still live. */
async function signedIn(db: Db, req: FastifyRequest): Promise<Me> {
  const h = req.headers.authorization;
  const claims = h?.startsWith('Bearer ') ? await verifyStaffAccessToken(h.slice(7)) : null;
  if (!claims) throw new HttpError(401, 'unauthenticated', 'Please log in to continue.');
  const [row] = await db
    .select({ staff: staffAccounts })
    .from(staffSessions)
    .innerJoin(staffAccounts, eq(staffAccounts.id, staffSessions.staffId))
    .where(
      and(
        eq(staffSessions.id, claims.sessionId),
        eq(staffSessions.staffId, claims.staffId),
        isNull(staffSessions.revokedAt),
        gt(staffSessions.expiresAt, new Date()),
        eq(staffAccounts.active, true),
      ),
    );
  if (!row) throw sessionExpired();
  return { ...row.staff, sessionId: claims.sessionId };
}

/** Owners only (the role as it is now, not as the token says). */
async function ownerSignedIn(db: Db, req: FastifyRequest): Promise<Me> {
  const me = await signedIn(db, req);
  if (me.role !== 'owner') throw new HttpError(403, 'forbidden', 'Only an owner can manage the team.');
  return me;
}

function card(o: OrderRow, customer: { name: string | null; phone: string | null }, itemCount: number) {
  return {
    number: o.number,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    itemCount,
    totalPaise: o.totalPaise,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    // the account's name and phone; a deleted account's are wiped, so the delivery address's instead
    customerName: customer.name || o.address.name || null,
    customerPhone: customer.phone || o.address.phone || null,
    city: o.address.city,
    pincode: o.address.pincode,
  };
}

/** The order page staff work from: what to pick, where it goes, the bill and who did what. */
async function staffOrder(db: Db, number: string) {
  const { o, u, items, events, nextStatuses } = await loadStoreOrder(db, number);
  return {
    ...card(o, u, items.reduce((n, i) => n + i.qty, 0)),
    address: o.address,
    deliveryInstructions: o.deliveryInstructions,
    /** path on this server, e.g. /voice/12/<id>.m4a */
    voiceNoteUrl: o.voiceNote ? `/voice/${o.voiceNote}` : null,
    items: items.map((i) => ({ sku: i.sku, name: i.name, image: i.image, qty: i.qty, unitPricePaise: i.unitPricePaise })),
    subtotalPaise: o.subtotalPaise,
    deliveryFeePaise: o.deliveryFeePaise,
    handlingFeePaise: o.handlingFeePaise,
    codFeePaise: o.codFeePaise,
    discountPaise: o.discountPaise,
    tipPaise: o.tipPaise,
    gstin: o.gstin,
    businessName: o.gstBusinessName,
    cancelReason: o.cancelReason,
    /** `by`: the staff member who made the change in the admin app (null for the customer, Wall2Roof and the admin route) */
    events: events.map((e) => ({ status: e.status, note: e.note, at: e.createdAt.toISOString(), by: e.actorLabel })),
    nextStatuses,
  };
}

const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

export async function staffRoutes(app: FastifyInstance, { db }: { db: Db }) {
  // ---- Logging in ----

  app.post('/v1/staff/auth/login', async (req) => {
    const body = parse(
      z.object({ username: z.string().trim().toLowerCase().min(1, 'Enter your username').max(64), password: z.string().min(1, 'Enter your password').max(128) }),
      req.body,
    );
    const [s] = await db.select().from(staffAccounts).where(eq(staffAccounts.username, body.username));
    if (!s || !s.active) {
      await verifyPassword(body.password, await dummy());
      throw badCredentials();
    }
    const fresh = await checkPassword(db, s, body.password, badCredentials, { lastLoginAt: new Date() });
    return (await createSession(db, fresh)).session;
  });

  /**
   * A new access token (and refresh token) for a refresh token, like the customer app: the old one stays
   * usable until the phone uses the new one, so a refresh whose reply got lost doesn't log anyone out.
   */
  app.post('/v1/staff/auth/refresh', async (req) => {
    const { refreshToken } = parse(refreshBody, req.body);
    const [row] = await db
      .select({ session: staffSessions, staff: staffAccounts })
      .from(staffSessions)
      .innerJoin(staffAccounts, eq(staffAccounts.id, staffSessions.staffId))
      .where(and(eq(staffSessions.tokenHash, sha256(refreshToken)), isNull(staffSessions.revokedAt), gt(staffSessions.expiresAt, new Date())));
    if (!row || !row.staff.active) throw sessionExpired();
    const now = new Date();
    // using this token proves the phone has it, so the token it replaced is finished
    await db
      .update(staffSessions)
      .set({ revokedAt: now })
      .where(and(eq(staffSessions.replacedById, row.session.id), isNull(staffSessions.revokedAt)));
    // swapped before but the phone never used the new one: retire that unused one
    if (row.session.replacedById) {
      await db
        .update(staffSessions)
        .set({ revokedAt: now })
        .where(and(eq(staffSessions.id, row.session.replacedById), isNull(staffSessions.revokedAt)));
    }
    const { refreshId, session } = await createSession(db, row.staff);
    await db.update(staffSessions).set({ replacedById: refreshId }).where(eq(staffSessions.id, row.session.id));
    return session;
  });

  /** Ends this login (and stops this phone's alerts when it sends its push token), even if the login had already expired. */
  app.post('/v1/staff/auth/logout', async (req) => {
    const body = parse(refreshBody.extend({ pushToken: z.string().trim().max(200).nullish() }), req.body);
    const [row] = await db.select().from(staffSessions).where(eq(staffSessions.tokenHash, sha256(body.refreshToken)));
    if (row) {
      // this login and the ones it was swapped with, so none of them can come back after logging out
      await db
        .update(staffSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            or(
              eq(staffSessions.id, row.id),
              eq(staffSessions.replacedById, row.id),
              row.replacedById ? eq(staffSessions.id, row.replacedById) : undefined,
            ),
            isNull(staffSessions.revokedAt),
          ),
        );
      if (body.pushToken) {
        await db.delete(staffPushTokens).where(and(eq(staffPushTokens.token, body.pushToken), eq(staffPushTokens.staffId, row.staffId)));
      }
    }
    return { ok: true };
  });

  app.get('/v1/staff/me', async (req) => ({ staff: publicStaff(await signedIn(db, req)) }));

  /**
   * Change my password (wrong current passwords count towards the lock, like logging in). My other
   * phones are logged out and every phone's alerts stop; the app then registers this phone again.
   */
  app.post('/v1/staff/me/password', async (req) => {
    const me = await signedIn(db, req);
    const body = parse(z.object({ currentPassword: z.string().min(1, 'Enter your current password').max(128), newPassword: staffPasswordSchema }), req.body);
    // 400, not 401: the app must not take a wrong current password for an expired login
    await checkPassword(db, me, body.currentPassword, () => new HttpError(400, 'wrong_password', 'Your current password is incorrect.'));
    const passwordHash = await hashPassword(body.newPassword);
    await db.transaction(async (tx) => {
      await tx.update(staffAccounts).set({ passwordHash, updatedAt: new Date() }).where(eq(staffAccounts.id, me.id));
      await logOutStaff(tx, me.id, { keepSessionId: me.sessionId, pushTokens: true });
    });
    return { ok: true };
  });

  // ---- The team (owners only) ----

  app.get('/v1/staff/team', async (req) => {
    await ownerSignedIn(db, req);
    const rows = await db
      .select()
      .from(staffAccounts)
      .orderBy(desc(staffAccounts.active), asc(sql`lower(${staffAccounts.name})`), asc(staffAccounts.id));
    return { staff: rows.map(teamMember) };
  });

  app.post('/v1/staff/team', async (req, reply) => {
    await ownerSignedIn(db, req);
    const body = parse(
      z.object({ name: staffNameSchema, username: usernameSchema, password: staffPasswordSchema, role: staffRoleSchema.default('staff') }),
      req.body,
    );
    const passwordHash = await hashPassword(body.password);
    const [s] = await db
      .insert(staffAccounts)
      .values({ name: body.name, username: body.username, passwordHash, role: body.role })
      .onConflictDoNothing({ target: staffAccounts.username })
      .returning();
    if (!s) throw new HttpError(409, 'username_taken', 'That username is already taken. Choose another.');
    reply.status(201);
    return { staff: teamMember(s) };
  });

  /**
   * Rename, reset the password, deactivate / reactivate or change the role. A password reset or
   * deactivation logs the person out of every phone and stops their alerts. Owners can't deactivate or
   * demote themselves, or reset their own password here (that needs the current one: /me/password),
   * and there is always at least one active owner.
   */
  app.patch('/v1/staff/team/:id', async (req) => {
    const me = await ownerSignedIn(db, req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        name: staffNameSchema.optional(),
        password: staffPasswordSchema.optional(),
        active: z.boolean().optional(),
        role: staffRoleSchema.optional(),
      }),
      req.body ?? {},
    );
    if (id === me.id && (body.active === false || body.role === 'staff')) {
      throw new HttpError(409, 'cannot_change_self', 'You can’t deactivate yourself or remove your own owner role. Ask another owner.');
    }
    if (id === me.id && body.password !== undefined) {
      throw new HttpError(409, 'use_my_password', 'Change your own password in Account, with your current password.');
    }
    const passwordHash = body.password ? await hashPassword(body.password) : undefined;
    const updated = await db.transaction(async (tx) => {
      // one change to the owners at a time, so two owners can't remove each other at the same moment
      const owners = await tx
        .select({ id: staffAccounts.id })
        .from(staffAccounts)
        .where(and(eq(staffAccounts.role, 'owner'), eq(staffAccounts.active, true)))
        .for('update');
      if (!owners.some((o) => o.id === me.id)) throw new HttpError(403, 'forbidden', 'Only an owner can manage the team.');
      const [s] = await tx
        .update(staffAccounts)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          // a reset also unlocks an account locked by wrong passwords
          ...(passwordHash ? { passwordHash, failedLogins: 0, lockedUntil: null } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
          ...(body.role ? { role: body.role } : {}),
          updatedAt: new Date(),
        })
        .where(eq(staffAccounts.id, id))
        .returning();
      if (!s) throw new HttpError(404, 'not_found', 'Team member not found.');
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(staffAccounts)
        .where(and(eq(staffAccounts.role, 'owner'), eq(staffAccounts.active, true)));
      if (!n) throw new HttpError(409, 'last_owner', 'There must always be at least one active owner.');
      // never me: I can't reset my own password or deactivate myself here
      if (passwordHash || body.active === false) await logOutStaff(tx, s.id, { pushTokens: true });
      return s;
    });
    return { staff: teamMember(updated) };
  });

  // ---- Orders ----

  app.get('/v1/staff/orders', async (req) => {
    await signedIn(db, req);
    const { status } = parse(z.object({ status: z.enum(['active', ...STATUSES]).default('active') }), req.query);
    const rows = await db
      .select({ o: orders, name: users.name, phone: users.phone })
      .from(orders)
      .innerJoin(users, eq(users.id, orders.userId))
      .where(status === 'active' ? inArray(orders.status, [...ACTIVE]) : eq(orders.status, status))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(100);
    const counts = rows.length
      ? await db
          .select({ orderId: orderItems.orderId, n: sql<number>`sum(${orderItems.qty})::int` })
          .from(orderItems)
          .where(inArray(orderItems.orderId, rows.map((r) => r.o.id)))
          .groupBy(orderItems.orderId)
      : [];
    const byOrder = new Map(counts.map((c) => [c.orderId, c.n]));
    return { orders: rows.map(({ o, name, phone }) => card(o, { name, phone }, byOrder.get(o.id) ?? 0)) };
  });

  app.get('/v1/staff/orders/:number', async (req) => {
    await signedIn(db, req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    return { order: await staffOrder(db, number) };
  });

  /** Mark picked / packed / dispatched / delivered, or cancel with a reason; the step records who did it. */
  app.post('/v1/staff/orders/:number/status', async (req) => {
    const me = await signedIn(db, req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    const body = parse(
      z.object({
        status: z.enum(['confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled']),
        note: z.string().trim().max(200).nullish(),
      }),
      req.body,
    );
    const note = body.note || undefined;
    if (body.status === 'cancelled' && !note) throw new HttpError(400, 'reason_required', 'Enter why the order is being cancelled.');
    await changeOrderStatus(db, number, body.status, note, me.name);
    return { ok: true, order: await staffOrder(db, number) };
  });

  // ---- New-order alerts ----

  /** This phone's Expo push token, now bound to whoever is logged in on it. */
  app.post('/v1/staff/push-token', async (req) => {
    const me = await signedIn(db, req);
    const body = parse(z.object({ token: expoPushTokenSchema, platform: z.enum(['android', 'ios']) }), req.body);
    await db
      .insert(staffPushTokens)
      .values({ staffId: me.id, token: body.token, platform: body.platform })
      .onConflictDoUpdate({ target: staffPushTokens.token, set: { staffId: me.id, platform: body.platform, lastSeenAt: new Date() } });
    return { ok: true };
  });

  app.delete('/v1/staff/push-token', async (req) => {
    const me = await signedIn(db, req);
    const { token } = parse(z.object({ token: z.string().trim().min(1).max(200) }), req.body);
    await db.delete(staffPushTokens).where(and(eq(staffPushTokens.token, token), eq(staffPushTokens.staffId, me.id)));
    return { ok: true };
  });
}
