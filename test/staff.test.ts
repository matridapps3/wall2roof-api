import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { and, eq, isNull } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { orderEvents, orders, products, staffAccounts, staffPushTokens, staffSessions, users } from '../src/db/schema.js';
import { hashPassword, signAccessToken, signStaffAccessToken } from '../src/lib/auth.js';
import { validateOwnerInput } from '../src/lib/staff-accounts.js';
import { VoiceStore } from '../src/lib/voice.js';
import { MAX_FAILED_LOGINS } from '../src/routes/staff.js';

const KEY = 'test-integration-key-0123456789-abcdefghij';
let h: DbHandle;
let app: FastifyInstance;
let dir: string;
let bulbId: number;
let customer: { token: string; refreshToken: string; id: number; addressId: number };

type Session = { accessToken: string; refreshToken: string; staff: { id: number; name: string; username: string; role: string } };

async function call(method: string, url: string, body?: unknown, auth?: string, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as never,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.json() as any };
}

/** A staff account straight in the database (what `npm run staff:owner` or an owner in the app makes). */
async function addStaff(username: string, name: string, password: string, role: 'owner' | 'staff' = 'staff', extra: Partial<typeof staffAccounts.$inferInsert> = {}) {
  const [s] = await h.db
    .insert(staffAccounts)
    .values({ username, name, role, passwordHash: await hashPassword(password), ...extra })
    .returning();
  return s;
}

async function staffLogin(username: string, password: string) {
  const r = await call('POST', '/v1/staff/auth/login', { username, password });
  expect(r.status).toBe(200);
  return r.body as Session;
}

const pushToken = (n: string) => `ExponentPushToken[${n}]`;
const tokensOf = async (staffId: number) =>
  (await h.db.select({ token: staffPushTokens.token }).from(staffPushTokens).where(eq(staffPushTokens.staffId, staffId))).map((t) => t.token).sort();
const liveSessions = async (staffId: number) =>
  h.db.$count(staffSessions, and(eq(staffSessions.staffId, staffId), isNull(staffSessions.revokedAt)));

/** The customer orders `qty` bulbs, cash on delivery. */
async function placeOrder(key: string, qty = 2, extra: object = {}) {
  await call('PUT', '/v1/cart/items', { productId: bulbId, qty }, customer.token);
  const o = await call('POST', '/v1/orders', { addressId: customer.addressId, paymentMethod: 'cod', idempotencyKey: key, ...extra }, customer.token);
  expect(o.status).toBe(201);
  return o.body.number as string;
}

const m4a = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(200, 1)]);

beforeAll(async () => {
  h = await openDb({ memory: true });
  dir = await mkdtemp(join(tmpdir(), 'ed-staff-'));
  app = await buildApp(h.db, {}, { voice: new VoiceStore(dir), integrationKey: KEY });
  const [p] = await h.db
    .insert(products)
    .values({ sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: ['https://example.com/b1.jpg'], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 50 })
    .returning();
  bulbId = p.id;
  const req = await call('POST', '/v1/auth/otp/request', { phone: '9876511111' });
  const ver = await call('POST', '/v1/auth/otp/verify', { phone: '9876511111', code: req.body.devCode });
  await call('PATCH', '/v1/me', { name: 'Priya Sharma' }, ver.body.accessToken);
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name: 'Priya Sharma', phone: '9876511111', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
    ver.body.accessToken,
  );
  customer = { token: ver.body.accessToken, refreshToken: ver.body.refreshToken, id: ver.body.user.id, addressId: a.body.address.id };
});

afterAll(async () => {
  await app.close();
  await h.close();
  await rm(dir, { recursive: true, force: true });
});

describe('admin app login', () => {
  it('logs in with username and password (any case) and returns the tokens and the staff member', async () => {
    const s = await addStaff('meena.k', 'Meena Kumari', 'packing-2026');
    const r = await call('POST', '/v1/staff/auth/login', { username: '  Meena.K ', password: 'packing-2026' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      staff: { id: s.id, name: 'Meena Kumari', username: 'meena.k', role: 'staff' },
    });
    expect((await call('GET', '/v1/staff/me', undefined, r.body.accessToken)).body).toEqual({
      staff: { id: s.id, name: 'Meena Kumari', username: 'meena.k', role: 'staff' },
    });
    const [row] = await h.db.select().from(staffAccounts).where(eq(staffAccounts.id, s.id));
    expect(row.lastLoginAt).not.toBeNull();
    // only the hash of the refresh token is kept
    const [sess] = await h.db.select().from(staffSessions).where(eq(staffSessions.staffId, s.id));
    expect(sess.tokenHash).not.toBe(r.body.refreshToken);
    expect(sess.expiresAt.getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
  });

  it('answers the same for an unknown username, a wrong password and a deactivated account', async () => {
    await addStaff('gone.staff', 'Gone Staff', 'packing-2026', 'staff', { active: false });
    for (const body of [
      { username: 'nobody', password: 'packing-2026' },
      { username: 'meena.k', password: 'wrong-password' },
      { username: 'gone.staff', password: 'packing-2026' },
    ]) {
      const r = await call('POST', '/v1/staff/auth/login', body);
      expect([r.status, r.body.error]).toEqual([401, { code: 'bad_credentials', message: 'Username or password is incorrect.' }]);
    }
    expect((await call('POST', '/v1/staff/auth/login', { username: 'meena.k' })).status).toBe(400);
    // a good login clears the wrong attempt
    await staffLogin('meena.k', 'packing-2026');
    const [row] = await h.db.select().from(staffAccounts).where(eq(staffAccounts.username, 'meena.k'));
    expect(row.failedLogins).toBe(0);
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const s = await addStaff('ravi', 'Ravi Kumar', 'packing-2026');
    for (let i = 1; i <= 4; i++) {
      expect((await call('POST', '/v1/staff/auth/login', { username: 'ravi', password: `wrong-${i}` })).status).toBe(401);
    }
    const fifth = await call('POST', '/v1/staff/auth/login', { username: 'ravi', password: 'wrong-5' });
    expect([fifth.status, fifth.body.error.code]).toEqual([429, 'locked']);
    expect(fifth.body.error.message).toBe('Too many wrong passwords. Try again in 15 minutes.');
    // even the right password waits
    const right = await call('POST', '/v1/staff/auth/login', { username: 'ravi', password: 'packing-2026' });
    expect([right.status, right.body.error.code]).toEqual([429, 'locked']);
    const [row] = await h.db.select().from(staffAccounts).where(eq(staffAccounts.id, s.id));
    expect(row.lockedUntil!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    // once the 15 minutes are over the right password works again
    await h.db.update(staffAccounts).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(staffAccounts.id, s.id));
    await staffLogin('ravi', 'packing-2026');
    const [after] = await h.db.select().from(staffAccounts).where(eq(staffAccounts.id, s.id));
    expect([after.failedLogins, after.lockedUntil]).toEqual([0, null]);
  });

  it('can’t be got around by sending many guesses at once', async () => {
    const s = await addStaff('burst', 'Burst Test', 'packing-2026');
    const results = await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => call('POST', '/v1/staff/auth/login', { username: 'burst', password: `wrong-${i}` })),
      call('POST', '/v1/staff/auth/login', { username: 'burst', password: 'packing-2026' }),
    ]);
    const statuses = results.map((r) => r.status);
    // at most 5 passwords are checked (the 5th wrong one locks); the other guesses are turned away unchecked
    expect(statuses.filter((st) => st === 401).length).toBeLessThanOrEqual(MAX_FAILED_LOGINS - 1);
    expect(statuses.filter((st) => st !== 401 && st !== 429)).toEqual([]);
    // the right password sent along with them doesn't get in, and doesn't clear the lock
    expect([results[20].status, results[20].body.error?.code]).toEqual([429, 'locked']);
    const [row] = await h.db.select().from(staffAccounts).where(eq(staffAccounts.id, s.id));
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await call('POST', '/v1/staff/auth/login', { username: 'burst', password: 'packing-2026' })).status).toBe(429);
  });

  it('swaps the refresh token on refresh, like the customer app', async () => {
    const s = await staffLogin('meena.k', 'packing-2026');
    const refresh = (t: string) => call('POST', '/v1/staff/auth/refresh', { refreshToken: t });

    const r1 = await refresh(s.refreshToken);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), staff: { username: 'meena.k', role: 'staff' } });
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    expect((await call('GET', '/v1/staff/me', undefined, r1.body.accessToken)).status).toBe(200);

    // the reply got lost: the old token still works once, and retires the one that never arrived
    const lost = await refresh(s.refreshToken);
    expect(lost.status).toBe(200);
    expect((await refresh(r1.body.refreshToken)).status).toBe(401);

    const r2 = await refresh(lost.body.refreshToken); // the phone uses its new token…
    expect(r2.status).toBe(200);
    const old = await refresh(s.refreshToken); // …so the first one is finished
    expect([old.status, old.body.error.code]).toEqual([401, 'session_expired']);
    expect((await refresh('x'.repeat(43))).status).toBe(401);
  });

  it('logs out: the login ends at once and that phone stops getting alerts', async () => {
    const [meena] = await h.db.select().from(staffAccounts).where(eq(staffAccounts.username, 'meena.k'));
    const phone = await staffLogin('meena.k', 'packing-2026');
    const other = await staffLogin('meena.k', 'packing-2026');
    for (const [s, t] of [
      [phone, 'logout-phone'],
      [other, 'logout-other'],
    ] as const) {
      expect((await call('POST', '/v1/staff/push-token', { token: pushToken(t), platform: 'android' }, s.accessToken)).body).toEqual({ ok: true });
    }
    expect(await tokensOf(meena.id)).toContain(pushToken('logout-phone'));

    const out = await call('POST', '/v1/staff/auth/logout', { refreshToken: phone.refreshToken, pushToken: pushToken('logout-phone') });
    expect(out.body).toEqual({ ok: true });
    expect((await call('POST', '/v1/staff/auth/refresh', { refreshToken: phone.refreshToken })).status).toBe(401);
    // the access token stops working too, not 30 minutes later
    expect((await call('GET', '/v1/staff/me', undefined, phone.accessToken)).body.error.code).toBe('session_expired');
    const left = await tokensOf(meena.id);
    expect(left).not.toContain(pushToken('logout-phone'));
    expect(left).toContain(pushToken('logout-other'));
    // the other phone is still logged in
    expect((await call('GET', '/v1/staff/me', undefined, other.accessToken)).status).toBe(200);
    // someone else's push token isn't touched by my log out
    const third = await staffLogin('meena.k', 'packing-2026');
    const ravi = await staffLogin('ravi', 'packing-2026');
    await call('POST', '/v1/staff/push-token', { token: pushToken('ravi-phone'), platform: 'ios' }, ravi.accessToken);
    await call('POST', '/v1/staff/auth/logout', { refreshToken: third.refreshToken, pushToken: pushToken('ravi-phone') });
    expect(await tokensOf(ravi.staff.id)).toEqual([pushToken('ravi-phone')]);
    // an unknown token is fine
    expect((await call('POST', '/v1/staff/auth/logout', { refreshToken: 'y'.repeat(43) })).body).toEqual({ ok: true });
  });

  it('changes my password and logs my other phones out', async () => {
    const asha = await addStaff('asha', 'Asha Rani', 'first-pass-1');
    const mine = await staffLogin('asha', 'first-pass-1');
    const other = await staffLogin('asha', 'first-pass-1');
    await call('POST', '/v1/staff/push-token', { token: pushToken('asha-mine'), platform: 'android' }, mine.accessToken);
    await call('POST', '/v1/staff/push-token', { token: pushToken('asha-lost'), platform: 'android' }, other.accessToken);

    const wrong = await call('POST', '/v1/staff/me/password', { currentPassword: 'nope-nope', newPassword: 'second-pass-2' }, mine.accessToken);
    expect([wrong.status, wrong.body.error.code]).toEqual([400, 'wrong_password']);
    const short = await call('POST', '/v1/staff/me/password', { currentPassword: 'first-pass-1', newPassword: 'short' }, mine.accessToken);
    expect([short.status, short.body.error.code]).toEqual([400, 'invalid_input']);

    const ok = await call('POST', '/v1/staff/me/password', { currentPassword: 'first-pass-1', newPassword: 'second-pass-2' }, mine.accessToken);
    expect(ok.body).toEqual({ ok: true });
    expect((await call('GET', '/v1/staff/me', undefined, mine.accessToken)).status).toBe(200);
    expect((await call('POST', '/v1/staff/auth/refresh', { refreshToken: mine.refreshToken })).status).toBe(200);
    expect((await call('GET', '/v1/staff/me', undefined, other.accessToken)).status).toBe(401);
    expect((await call('POST', '/v1/staff/auth/refresh', { refreshToken: other.refreshToken })).status).toBe(401);
    // a lost phone stops getting alerts too; the app registers this phone again straight after
    expect(await tokensOf(asha.id)).toEqual([]);

    expect((await call('POST', '/v1/staff/auth/login', { username: 'asha', password: 'first-pass-1' })).status).toBe(401);
    await staffLogin('asha', 'second-pass-2');
  });

  it('counts wrong current passwords towards the lock, like wrong logins', async () => {
    await addStaff('kiran', 'Kiran Pal', 'kiran-pass-1');
    const me = await staffLogin('kiran', 'kiran-pass-1');
    const change = (currentPassword: string) => call('POST', '/v1/staff/me/password', { currentPassword, newPassword: 'kiran-pass-2' }, me.accessToken);
    for (let i = 1; i < MAX_FAILED_LOGINS; i++) expect((await change(`guess-${i}`)).body.error.code).toBe('wrong_password');
    const last = await change('guess-last');
    expect([last.status, last.body.error.code]).toEqual([429, 'locked']);
    // locked: not even the right one is checked, here or at login
    expect((await change('kiran-pass-1')).status).toBe(429);
    expect((await call('POST', '/v1/staff/auth/login', { username: 'kiran', password: 'kiran-pass-1' })).status).toBe(429);
    // this phone stays logged in
    expect((await call('GET', '/v1/staff/me', undefined, me.accessToken)).status).toBe(200);
  });

  it('accepts only Expo push tokens, and moves a phone to whoever logs in on it', async () => {
    const meena = await staffLogin('meena.k', 'packing-2026');
    const asha = await staffLogin('asha', 'second-pass-2');
    for (const body of [{ token: 'not-a-token', platform: 'android' }, { token: pushToken('x'), platform: 'web' }, { platform: 'ios' }]) {
      expect((await call('POST', '/v1/staff/push-token', body, meena.accessToken)).status).toBe(400);
    }
    await call('POST', '/v1/staff/push-token', { token: pushToken('shared-phone'), platform: 'android' }, meena.accessToken);
    expect(await tokensOf(meena.staff.id)).toContain(pushToken('shared-phone'));
    // the same phone, now logged in as Asha
    await call('POST', '/v1/staff/push-token', { token: pushToken('shared-phone'), platform: 'android' }, asha.accessToken);
    expect(await tokensOf(meena.staff.id)).not.toContain(pushToken('shared-phone'));
    expect(await tokensOf(asha.staff.id)).toEqual([pushToken('shared-phone')]);
    // removing it: only my own
    expect((await call('DELETE', '/v1/staff/push-token', { token: pushToken('shared-phone') }, meena.accessToken)).body).toEqual({ ok: true });
    expect(await tokensOf(asha.staff.id)).toEqual([pushToken('shared-phone')]);
    expect((await call('DELETE', '/v1/staff/push-token', { token: pushToken('shared-phone') }, asha.accessToken)).body).toEqual({ ok: true });
    expect(await tokensOf(asha.staff.id)).toEqual([]);
  });
});

describe('admin app and customer logins are kept apart', () => {
  const staffRoutes = (n: string): [string, string, unknown?][] => [
    ['GET', '/v1/staff/me'],
    ['POST', '/v1/staff/me/password', { currentPassword: 'packing-2026', newPassword: 'whatever-123' }],
    ['GET', '/v1/staff/team'],
    ['POST', '/v1/staff/team', { name: 'X', username: 'xyz', password: 'packing-2026' }],
    ['PATCH', '/v1/staff/team/1', { name: 'X' }],
    ['GET', '/v1/staff/orders'],
    ['GET', `/v1/staff/orders/${n}`],
    ['POST', `/v1/staff/orders/${n}/status`, { status: 'confirmed' }],
    ['POST', '/v1/staff/push-token', { token: pushToken('c'), platform: 'android' }],
    ['DELETE', '/v1/staff/push-token', { token: pushToken('c') }],
  ];

  it('refuses customer logins (and none) on every admin app route', async () => {
    const n = await placeOrder('apart-order-1', 1);
    const [admin] = await h.db.insert(users).values({ name: 'Admin', email: 'admin@example.com', role: 'admin' }).returning();
    const adminToken = await signAccessToken(admin.id, 'admin');
    for (const [method, url, body] of staffRoutes(n)) {
      for (const token of [customer.token, adminToken, undefined]) {
        const r = await call(method, url, body, token);
        expect([method, url, r.status, r.body.error.code]).toEqual([method, url, 401, 'unauthenticated']);
      }
    }
    expect((await h.db.select().from(orders).where(eq(orders.number, n)))[0].status).toBe('placed');
    // a customer refresh token isn't an admin app login either (and the other way round)
    expect((await call('POST', '/v1/staff/auth/refresh', { refreshToken: customer.refreshToken })).status).toBe(401);
    const s = await staffLogin('meena.k', 'packing-2026');
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('refuses admin app logins on customer routes', async () => {
    const owner = await addStaff('apart.owner', 'Apart Owner', 'packing-2026', 'owner');
    const s = await staffLogin('apart.owner', 'packing-2026');
    // the staff id may equal a customer id: still not that customer
    const forged = await signStaffAccessToken({ staffId: customer.id, role: 'owner', sessionId: 1 });
    const n = (await h.db.select().from(orders).limit(1))[0].number;
    const routes: [string, string, unknown?][] = [
      ['GET', '/v1/me'],
      ['PATCH', '/v1/me', { name: 'X' }],
      ['GET', '/v1/addresses'],
      ['GET', '/v1/cart'],
      ['PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }],
      ['GET', '/v1/orders'],
      ['POST', '/v1/orders', { addressId: customer.addressId, paymentMethod: 'cod', idempotencyKey: 'apart-staff-1' }],
      ['GET', `/v1/orders/${n}`],
      ['POST', `/v1/orders/${n}/cancel`, {}],
      ['GET', '/v1/notifications'],
      ['GET', '/v1/wishlist'],
      ['GET', '/v1/me/buy-again'],
      ['POST', `/v1/admin/orders/${n}/status`, { status: 'confirmed' }],
    ];
    for (const [method, url, body] of routes) {
      for (const token of [s.accessToken, forged]) {
        const r = await call(method, url, body, token);
        expect([method, url, r.status]).toEqual([method, url, 401]);
      }
    }
    // and a token that says staff but isn't one of ours, or has no login behind it
    const fake = await new SignJWT({ typ: 'staff', role: 'owner', sid: 999 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(owner.id))
      .setIssuedAt()
      .setExpirationTime('30m')
      .setIssuer('electrodash')
      .sign(new TextEncoder().encode('another-secret-another-secret-another-secret'));
    expect((await call('GET', '/v1/staff/me', undefined, fake)).status).toBe(401);
    const noSession = await signStaffAccessToken({ staffId: owner.id, role: 'owner', sessionId: 999_999 });
    expect((await call('GET', '/v1/staff/me', undefined, noSession)).body.error.code).toBe('session_expired');
    // a login issued with our secret but no typ is a customer token, not staff
    const plain = await new SignJWT({ role: 'owner', sid: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(owner.id))
      .setIssuedAt()
      .setExpirationTime('30m')
      .setIssuer('electrodash')
      .sign(config.jwtSecret);
    expect((await call('GET', '/v1/staff/me', undefined, plain)).status).toBe(401);
  });
});

describe('team (owners only)', () => {
  let owner: Session;
  let staff: Session;

  beforeAll(async () => {
    await addStaff('vivek', 'Vivek Sharma', 'owner-pass-1', 'owner');
    owner = await staffLogin('vivek', 'owner-pass-1');
    staff = await staffLogin('meena.k', 'packing-2026');
  });

  it('is closed to staff', async () => {
    for (const [method, url, body] of [
      ['GET', '/v1/staff/team'],
      ['POST', '/v1/staff/team', { name: 'New Person', username: 'new.person', password: 'packing-2026' }],
      ['PATCH', `/v1/staff/team/${staff.staff.id}`, { name: 'Meena' }],
    ] as [string, string, unknown?][]) {
      const r = await call(method, url, body, staff.accessToken);
      expect([r.status, r.body.error.code]).toEqual([403, 'forbidden']);
    }
    expect(await h.db.$count(staffAccounts, eq(staffAccounts.username, 'new.person'))).toBe(0);
  });

  it('adds a teammate, who can log in at once', async () => {
    const r = await call('POST', '/v1/staff/team', { name: '  Sunil Verma ', username: 'Sunil_V', password: 'sunil-pass-1' }, owner.accessToken);
    expect(r.status).toBe(201);
    expect(r.body.staff).toEqual({
      id: expect.any(Number),
      name: 'Sunil Verma',
      username: 'sunil_v',
      role: 'staff',
      active: true,
      lastLoginAt: null,
      createdAt: expect.any(String),
    });
    await staffLogin('sunil_v', 'sunil-pass-1');
    const o = await call('POST', '/v1/staff/team', { name: 'Second Owner', username: 'owner2', password: 'owner-pass-2', role: 'owner' }, owner.accessToken);
    expect(o.body.staff.role).toBe('owner');

    const list = (await call('GET', '/v1/staff/team', undefined, owner.accessToken)).body.staff;
    expect(list.map((s: any) => s.username)).toEqual(expect.arrayContaining(['vivek', 'meena.k', 'sunil_v', 'owner2', 'gone.staff']));
    expect(list.at(-1)).toMatchObject({ username: 'gone.staff', active: false }); // deactivated ones last
    expect(list.find((s: any) => s.username === 'sunil_v').lastLoginAt).not.toBeNull();
    for (const s of list) expect(Object.keys(s).sort()).toEqual(['active', 'createdAt', 'id', 'lastLoginAt', 'name', 'role', 'username']);
  });

  it('refuses a username that is taken (in any case) or not valid, and a short password', async () => {
    const taken = await call('POST', '/v1/staff/team', { name: 'Another Meena', username: 'MEENA.K', password: 'packing-2026' }, owner.accessToken);
    expect([taken.status, taken.body.error.code]).toEqual([409, 'username_taken']);
    for (const body of [
      { name: 'A', username: 'ab', password: 'packing-2026' },
      { name: 'A', username: 'has space', password: 'packing-2026' },
      { name: 'A', username: 'x'.repeat(33), password: 'packing-2026' },
      { name: 'A', username: 'good.name', password: 'short' },
      { name: ' ', username: 'good.name', password: 'packing-2026' },
      { name: 'A', username: 'good.name', password: 'packing-2026', role: 'admin' },
    ]) {
      const r = await call('POST', '/v1/staff/team', body, owner.accessToken);
      expect([r.status, r.body.error.code]).toEqual([400, 'invalid_input']);
    }
  });

  it('a password reset logs the person out everywhere and stops their alerts', async () => {
    const sunil = await staffLogin('sunil_v', 'sunil-pass-1');
    await call('POST', '/v1/staff/push-token', { token: pushToken('sunil-phone'), platform: 'android' }, sunil.accessToken);
    expect(await liveSessions(sunil.staff.id)).toBeGreaterThan(0);

    const r = await call('PATCH', `/v1/staff/team/${sunil.staff.id}`, { password: 'reset-pass-9' }, owner.accessToken);
    expect(r.status).toBe(200);
    expect(r.body.staff).toMatchObject({ id: sunil.staff.id, username: 'sunil_v', active: true });
    expect(await liveSessions(sunil.staff.id)).toBe(0);
    expect(await tokensOf(sunil.staff.id)).toEqual([]);
    expect((await call('GET', '/v1/staff/me', undefined, sunil.accessToken)).status).toBe(401);
    expect((await call('POST', '/v1/staff/auth/refresh', { refreshToken: sunil.refreshToken })).status).toBe(401);
    expect((await call('POST', '/v1/staff/auth/login', { username: 'sunil_v', password: 'sunil-pass-1' })).status).toBe(401);
    await staffLogin('sunil_v', 'reset-pass-9');
  });

  it('deactivating logs the person out and stops their alerts; reactivating lets them back in', async () => {
    const sunil = await staffLogin('sunil_v', 'reset-pass-9');
    await call('POST', '/v1/staff/push-token', { token: pushToken('sunil-phone-2'), platform: 'ios' }, sunil.accessToken);

    const r = await call('PATCH', `/v1/staff/team/${sunil.staff.id}`, { active: false }, owner.accessToken);
    expect(r.body.staff).toMatchObject({ active: false });
    expect(await liveSessions(sunil.staff.id)).toBe(0);
    expect(await tokensOf(sunil.staff.id)).toEqual([]);
    expect((await call('GET', '/v1/staff/orders', undefined, sunil.accessToken)).status).toBe(401);
    expect((await call('POST', '/v1/staff/auth/login', { username: 'sunil_v', password: 'reset-pass-9' })).body.error.code).toBe('bad_credentials');

    await call('PATCH', `/v1/staff/team/${sunil.staff.id}`, { active: true, name: 'Sunil V.' }, owner.accessToken);
    expect((await staffLogin('sunil_v', 'reset-pass-9')).staff.name).toBe('Sunil V.');
    // a rename alone logs nobody out
    const again = await staffLogin('sunil_v', 'reset-pass-9');
    await call('PATCH', `/v1/staff/team/${sunil.staff.id}`, { name: 'Sunil Verma' }, owner.accessToken);
    expect((await call('GET', '/v1/staff/me', undefined, again.accessToken)).body.staff.name).toBe('Sunil Verma');
    expect((await call('PATCH', '/v1/staff/team/99999', { name: 'X' }, owner.accessToken)).status).toBe(404);
  });

  it('a role change applies at once, without logging in again', async () => {
    const sunil = await staffLogin('sunil_v', 'reset-pass-9');
    expect((await call('GET', '/v1/staff/team', undefined, sunil.accessToken)).status).toBe(403);
    await call('PATCH', `/v1/staff/team/${sunil.staff.id}`, { role: 'owner' }, owner.accessToken);
    expect((await call('GET', '/v1/staff/team', undefined, sunil.accessToken)).status).toBe(200);
    expect((await call('GET', '/v1/staff/me', undefined, sunil.accessToken)).body.staff.role).toBe('owner');
    await call('PATCH', `/v1/staff/team/${sunil.staff.id}`, { role: 'staff' }, owner.accessToken);
    expect((await call('GET', '/v1/staff/team', undefined, sunil.accessToken)).status).toBe(403);
  });

  it('an owner cannot deactivate or demote themselves', async () => {
    for (const body of [{ active: false }, { role: 'staff' }]) {
      const r = await call('PATCH', `/v1/staff/team/${owner.staff.id}`, body, owner.accessToken);
      expect([r.status, r.body.error.code]).toEqual([409, 'cannot_change_self']);
    }
    // nor reset their own password here: that needs the current one (Account → Change password)
    const own = await call('PATCH', `/v1/staff/team/${owner.staff.id}`, { password: 'owner-pass-1b' }, owner.accessToken);
    expect([own.status, own.body.error.code]).toEqual([409, 'use_my_password']);
    expect((await call('POST', '/v1/staff/auth/login', { username: 'vivek', password: 'owner-pass-1b' })).status).toBe(401);
    // a rename is fine
    expect((await call('PATCH', `/v1/staff/team/${owner.staff.id}`, { name: 'Vivek S.' }, owner.accessToken)).body.staff).toMatchObject({ name: 'Vivek S.', role: 'owner', active: true });
    const [row] = await h.db.select().from(staffAccounts).where(eq(staffAccounts.id, owner.staff.id));
    expect([row.role, row.active]).toEqual(['owner', true]);
  });

  it('always keeps one active owner, even when two owners remove each other at the same moment', async () => {
    // only Vivek and a fresh second owner are owners from here on
    await h.db.update(staffAccounts).set({ role: 'staff' }).where(eq(staffAccounts.username, 'apart.owner'));
    const owner2 = await staffLogin('owner2', 'owner-pass-2');
    const [a, b] = await Promise.all([
      call('PATCH', `/v1/staff/team/${owner2.staff.id}`, { role: 'staff' }, owner.accessToken),
      call('PATCH', `/v1/staff/team/${owner.staff.id}`, { active: false }, owner2.accessToken),
    ]);
    // one goes through; the other finds its sender is no longer an owner (403), or was logged out (401)
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    expect([401, 403]).toContain([a.status, b.status].find((s) => s !== 200));
    const owners = await h.db.select().from(staffAccounts).where(and(eq(staffAccounts.role, 'owner'), eq(staffAccounts.active, true)));
    expect(owners).toHaveLength(1);
    // the one left can't be removed by anyone
    const left = owners[0].id === owner.staff.id ? owner : owner2;
    for (const body of [{ active: false }, { role: 'staff' }]) {
      expect((await call('PATCH', `/v1/staff/team/${left.staff.id}`, body, left.accessToken)).status).toBe(409);
    }
    // put things back for the tests below
    await h.db.update(staffAccounts).set({ role: 'owner', active: true }).where(eq(staffAccounts.id, owner.staff.id));
    owner = await staffLogin('vivek', 'owner-pass-1');
  });
});

describe('orders in the admin app', () => {
  let meena: Session;
  let ravi: Session;
  let number: string;
  let second: string;
  let voiceId: string;

  beforeAll(async () => {
    meena = await staffLogin('meena.k', 'packing-2026');
    ravi = await staffLogin('ravi', 'packing-2026');
    // the orders placed by earlier tests are out of the way
    await h.db.update(orders).set({ status: 'cancelled' });
    voiceId = (await call('POST', '/v1/voice-notes', m4a, customer.token, { 'content-type': 'audio/mp4' })).body.id;
    number = await placeOrder('staff-flow-1', 2, { instructions: ['Call on arrival'], voiceNoteId: voiceId });
    second = await placeOrder('staff-flow-2', 3);
  });

  it('lists the orders still to send out, newest first', async () => {
    const mine = (await call('GET', `/v1/orders/${number}`, undefined, customer.token)).body;
    const r = await call('GET', '/v1/staff/orders', undefined, meena.accessToken);
    expect(r.status).toBe(200);
    expect(r.body.orders.map((o: any) => o.number)).toEqual([second, number]);
    expect(r.body.orders[1]).toEqual({
      number,
      status: 'placed',
      createdAt: mine.placedAt,
      itemCount: 2,
      totalPaise: mine.totalPaise,
      paymentMethod: 'cod',
      paymentStatus: 'cod_due',
      customerName: 'Priya Sharma',
      customerPhone: '9876511111',
      city: 'Mohali',
      pincode: '140306',
    });
    expect((await call('GET', '/v1/staff/orders?status=placed', undefined, meena.accessToken)).body.orders).toHaveLength(2);
    expect((await call('GET', '/v1/staff/orders?status=delivered', undefined, meena.accessToken)).body.orders).toEqual([]);
    expect((await call('GET', '/v1/staff/orders?status=shipped', undefined, meena.accessToken)).status).toBe(400);
  });

  it('shows the whole order: what to pick, where it goes, the bill and the next steps', async () => {
    const mine = (await call('GET', `/v1/orders/${number}`, undefined, customer.token)).body;
    const r = await call('GET', `/v1/staff/orders/${number}`, undefined, meena.accessToken);
    expect(r.status).toBe(200);
    expect(r.body.order).toEqual({
      number,
      status: 'placed',
      createdAt: mine.placedAt,
      itemCount: 2,
      totalPaise: mine.bill.totalPaise,
      paymentMethod: 'cod',
      paymentStatus: 'cod_due',
      customerName: 'Priya Sharma',
      customerPhone: '9876511111',
      city: 'Mohali',
      pincode: '140306',
      address: expect.objectContaining({ name: 'Priya Sharma', phone: '9876511111', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' }),
      deliveryInstructions: ['Call on arrival'],
      voiceNoteUrl: `/voice/${customer.id}/${voiceId}.m4a`,
      items: [{ sku: 'B1', name: '9W LED Bulb', image: 'https://example.com/b1.jpg', qty: 2, unitPricePaise: 50_000 }],
      subtotalPaise: mine.bill.subtotalPaise,
      deliveryFeePaise: mine.bill.deliveryFeePaise,
      handlingFeePaise: mine.bill.handlingFeePaise,
      codFeePaise: mine.bill.codFeePaise,
      discountPaise: 0,
      tipPaise: 0,
      gstin: null,
      businessName: null,
      cancelReason: null,
      events: [{ status: 'placed', note: null, at: expect.any(String), by: null }],
      nextStatuses: ['confirmed', 'cancelled'],
    });
    const nf = await call('GET', '/v1/staff/orders/ED-0000-00000', undefined, meena.accessToken);
    expect([nf.status, nf.body.error.code]).toEqual([404, 'not_found']);
  });

  it('moves an order through picked, packed, dispatched and delivered, recording who did each step', async () => {
    const steps: [string, Session, string[]][] = [
      ['confirmed', meena, ['packed', 'cancelled']],
      ['packed', meena, ['out_for_delivery', 'cancelled']],
      ['out_for_delivery', ravi, ['delivered']],
      ['delivered', ravi, []],
    ];
    for (const [status, who, next] of steps) {
      const r = await call('POST', `/v1/staff/orders/${number}/status`, { status }, who.accessToken);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.order).toMatchObject({ number, status, nextStatuses: next });
    }
    const d = (await call('GET', `/v1/staff/orders/${number}`, undefined, meena.accessToken)).body.order;
    expect(d.paymentStatus).toBe('paid'); // cash collected on delivery
    expect(d.events.map((e: any) => [e.status, e.by])).toEqual([
      ['placed', null],
      ['confirmed', 'Meena Kumari'],
      ['packed', 'Meena Kumari'],
      ['out_for_delivery', 'Ravi Kumar'],
      ['delivered', 'Ravi Kumar'],
    ]);
    // the name is kept on the event; actor_user_id (customer accounts) stays empty
    const [o] = await h.db.select().from(orders).where(eq(orders.number, number));
    const rows = await h.db.select().from(orderEvents).where(eq(orderEvents.orderId, o.id));
    expect(rows.map((e) => e.actorUserId)).toEqual([null, null, null, null, null]);

    // it leaves the active list for the delivered one, and the customer heard about each step
    expect((await call('GET', '/v1/staff/orders', undefined, meena.accessToken)).body.orders.map((x: any) => x.number)).toEqual([second]);
    expect((await call('GET', '/v1/staff/orders?status=delivered', undefined, meena.accessToken)).body.orders.map((x: any) => x.number)).toEqual([number]);
    const titles = (await call('GET', '/v1/notifications', undefined, customer.token)).body.notifications.map((n: any) => n.title);
    for (const t of ['Order confirmed', 'Order packed', 'Out for delivery', 'Delivered']) expect(titles).toContain(`${t} · #${number}`);
  });

  it('refuses a step out of order', async () => {
    const skip = await call('POST', `/v1/staff/orders/${second}/status`, { status: 'delivered' }, meena.accessToken);
    expect([skip.status, skip.body.error.code]).toEqual([409, 'invalid_transition']);
    const back = await call('POST', `/v1/staff/orders/${number}/status`, { status: 'packed' }, meena.accessToken);
    expect([back.status, back.body.error.code]).toEqual([409, 'invalid_transition']);
    expect((await call('POST', `/v1/staff/orders/${second}/status`, { status: 'placed' }, meena.accessToken)).status).toBe(400);
    expect((await call('POST', '/v1/staff/orders/ED-0000-00000/status', { status: 'confirmed' }, meena.accessToken)).status).toBe(404);
  });

  it('cancels only with a reason, puts the stock back and records who did it', async () => {
    for (const body of [{ status: 'cancelled' }, { status: 'cancelled', note: '   ' }]) {
      const r = await call('POST', `/v1/staff/orders/${second}/status`, body, meena.accessToken);
      expect([r.status, r.body.error.code]).toEqual([400, 'reason_required']);
    }
    const [before] = await h.db.select().from(products).where(eq(products.id, bulbId));
    const r = await call('POST', `/v1/staff/orders/${second}/status`, { status: 'cancelled', note: 'Customer called to cancel' }, meena.accessToken);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ status: 'cancelled', cancelReason: 'Customer called to cancel', nextStatuses: [] });
    expect(r.body.order.events.at(-1)).toMatchObject({ status: 'cancelled', note: 'Customer called to cancel', by: 'Meena Kumari' });
    const [after] = await h.db.select().from(products).where(eq(products.id, bulbId));
    expect(after.stockQty).toBe(before.stockQty + 3);
    expect((await call('GET', '/v1/staff/orders?status=cancelled', undefined, meena.accessToken)).body.orders[0].number).toBe(second);
  });

  it('the admin route and Wall2Roof still work, without a name on their steps', async () => {
    const n = await placeOrder('staff-others-1', 1);
    await call('POST', `/v1/staff/orders/${n}/status`, { status: 'confirmed' }, meena.accessToken);
    const w2r = await app.inject({
      method: 'POST',
      url: `/v1/integration/orders/${n}/status`,
      payload: { status: 'packed' },
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(w2r.json()).toEqual({ ok: true });
    const [admin] = await h.db.insert(users).values({ name: 'Store Admin', email: 'store-admin@example.com', role: 'admin' }).returning();
    const adminMove = await call('POST', `/v1/admin/orders/${n}/status`, { status: 'out_for_delivery' }, await signAccessToken(admin.id, 'admin'));
    expect(adminMove.body).toEqual({ ok: true });
    const d = (await call('GET', `/v1/staff/orders/${n}`, undefined, meena.accessToken)).body.order;
    expect(d.events.map((e: any) => e.by)).toEqual([null, 'Meena Kumari', null, null]);
    // Wall2Roof's own order JSON is as it was
    const full = await app.inject({ method: 'GET', url: `/v1/integration/orders/${n}`, headers: { authorization: `Bearer ${KEY}` } });
    expect(full.json().events.map((e: any) => Object.keys(e).sort())).toEqual(Array(4).fill(['created_at', 'note', 'status']));
  });

  it('never shows the customer who moved their order', async () => {
    const d = (await call('GET', `/v1/orders/${number}`, undefined, customer.token)).body;
    expect(d.timeline.map((e: any) => e.status)).toEqual(['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered']);
    for (const e of d.timeline) expect(Object.keys(e).sort()).toEqual(['at', 'note', 'status']);
    const seen = JSON.stringify([
      d,
      (await call('GET', `/v1/orders/${second}`, undefined, customer.token)).body,
      (await call('GET', '/v1/orders', undefined, customer.token)).body,
      (await call('GET', '/v1/notifications', undefined, customer.token)).body,
    ]);
    for (const who of ['Meena', 'Ravi', 'meena.k']) expect(seen).not.toContain(who);
  });
});

describe('npm run staff:owner checks', () => {
  it('takes a valid username (made lower-case), name and password', () => {
    expect(validateOwnerInput({ STAFF_USERNAME: ' Vivek.S ', STAFF_NAME: ' Vivek Sharma ', STAFF_PASSWORD: 'p@ss word&1!' })).toEqual({
      ok: true,
      value: { username: 'vivek.s', name: 'Vivek Sharma', password: 'p@ss word&1!' },
    });
  });

  it('says what is missing or wrong, naming what the .cmd asked', () => {
    expect(validateOwnerInput({})).toEqual({
      ok: false,
      errors: ['Username is missing (STAFF_USERNAME).', 'Full name is missing (STAFF_NAME).', 'Password is missing (STAFF_PASSWORD).'],
    });
    const bad = validateOwnerInput({ STAFF_USERNAME: 'vs', STAFF_NAME: 'x'.repeat(81), STAFF_PASSWORD: 'short' });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toEqual([
      'Username: Use 3 to 32 lower-case letters, numbers, dots, dashes or underscores.',
      'Full name: Use at most 80 characters.',
      'Password: Use at least 8 characters.',
    ]);
    expect(validateOwnerInput({ STAFF_USERNAME: 'has space', STAFF_NAME: 'A', STAFF_PASSWORD: 'long-enough' }).ok).toBe(false);
    expect(validateOwnerInput({ STAFF_USERNAME: 'abc', STAFF_NAME: '   ', STAFF_PASSWORD: 'long-enough' }).ok).toBe(false);
    expect(validateOwnerInput({ STAFF_USERNAME: 'abc', STAFF_NAME: 'A', STAFF_PASSWORD: 'x'.repeat(129) }).ok).toBe(false);
  });
});
