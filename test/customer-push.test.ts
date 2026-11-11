import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { products, refreshTokens, staffAccounts, userPushTokens, users } from '../src/db/schema.js';
import { hashPassword, newRefreshToken, signAccessToken } from '../src/lib/auth.js';
import type { PushMessage, PushSender, PushTicket } from '../src/lib/push.js';

const KEY = 'test-integration-key-0123456789-abcdefghij';

let h: DbHandle;
let app: FastifyInstance;
let bulbId: number;
let admin: string;

/** What the server sent; `fail` makes the sender throw like Expo being down; `answer` is Expo's reply. */
let sent: PushMessage[][] = [];
let attempts = 0;
let fail = false;
let answer: (m: PushMessage[]) => PushTicket[] = (m) => m.map((_, i) => ({ status: 'ok', id: `t${i}` }));
const fake: PushSender = {
  async send(m) {
    attempts++;
    if (fail) throw new Error('Expo is down');
    sent.push(m);
    return answer(m);
  },
};

const pushToken = (n: string) => `ExponentPushToken[${n}]`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, url: string, body?: unknown, auth?: string) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as never, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

type Customer = { id: number; token: string; refresh: string; addressId: number };
let n = 0;
/** A logged-in customer (a live refresh token) with an address. */
async function customer(name: string): Promise<Customer> {
  const [u] = await h.db.insert(users).values({ name, phone: `98765${String(++n).padStart(5, '0')}` }).returning();
  const token = await signAccessToken(u.id, 'customer');
  const r = newRefreshToken();
  await h.db.insert(refreshTokens).values({ userId: u.id, tokenHash: r.hash, expiresAt: new Date(Date.now() + 30 * 86_400_000) });
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name, phone: '9876511111', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
    token,
  );
  return { id: u.id, token, refresh: r.token, addressId: a.body.address.id };
}
async function order(c: Customer, key: string) {
  await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, c.token);
  const o = await call('POST', '/v1/orders', { addressId: c.addressId, paymentMethod: 'cod', idempotencyKey: `push-test-${key}` }, c.token);
  expect(o.body).toMatchObject({ number: expect.any(String) });
  return o.body.number as string;
}
const move = (number: string, status: string, note?: string) => call('POST', `/v1/admin/orders/${number}/status`, { status, ...(note ? { note } : {}) }, admin);
const phone = (c: Customer, t: string) => call('POST', '/v1/me/push-token', { token: pushToken(t), platform: 'android' }, c.token);
const tokensOf = async (userId: number) =>
  (await h.db.select({ token: userPushTokens.token }).from(userPushTokens).where(eq(userPushTokens.userId, userId))).map((t) => t.token).sort();

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { push: fake, integrationKey: KEY });
  const [p] = await h.db.insert(products).values({ sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 1000 }).returning();
  bulbId = p.id;
  const [a] = await h.db.insert(users).values({ name: 'Owner', phone: '9876599999' }).returning();
  admin = await signAccessToken(a.id, 'admin');
});

afterEach(() => {
  sent = [];
  attempts = 0;
  fail = false;
  answer = (m) => m.map((_, i) => ({ status: 'ok', id: `t${i}` }));
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('Saving the customer phone (POST/DELETE /v1/me/push-token)', () => {
  it('saves the phone for the logged-in customer, once', async () => {
    const c = await customer('Priya');
    expect((await phone(c, 'priya-1')).status).toBe(200);
    expect((await phone(c, 'priya-1')).status).toBe(200);
    expect(await tokensOf(c.id)).toEqual([pushToken('priya-1')]);
  });

  it('moves the phone to whoever logs in on it last', async () => {
    const a = await customer('Asha');
    const b = await customer('Bina');
    await phone(a, 'shared');
    await phone(b, 'shared');
    expect(await tokensOf(a.id)).toEqual([]);
    expect(await tokensOf(b.id)).toEqual([pushToken('shared')]);
  });

  it('needs a login and a real Expo push token', async () => {
    const c = await customer('Kiran');
    expect((await call('POST', '/v1/me/push-token', { token: pushToken('x'), platform: 'android' })).status).toBe(401);
    expect((await call('POST', '/v1/me/push-token', { token: 'not-a-token', platform: 'android' }, c.token)).status).toBe(400);
    expect((await call('POST', '/v1/me/push-token', { token: pushToken('x'), platform: 'web' }, c.token)).status).toBe(400);
  });

  it('DELETE removes only this customer’s phone', async () => {
    const a = await customer('Deep');
    const b = await customer('Esha');
    await phone(a, 'deep-1');
    await phone(b, 'esha-1');
    expect((await call('DELETE', '/v1/me/push-token', { token: pushToken('esha-1') }, a.token)).status).toBe(200);
    expect(await tokensOf(b.id)).toEqual([pushToken('esha-1')]);
    await call('DELETE', '/v1/me/push-token', { token: pushToken('deep-1') }, a.token);
    expect(await tokensOf(a.id)).toEqual([]);
  });

  it('logging out with the phone’s token removes it', async () => {
    const c = await customer('Farah');
    await phone(c, 'farah-1');
    const r = await call('POST', '/v1/auth/logout', { refreshToken: c.refresh, pushToken: pushToken('farah-1') });
    expect(r.status).toBe(200);
    expect(await tokensOf(c.id)).toEqual([]);
  });

  it('deleting the account removes the phones', async () => {
    const c = await customer('Gita');
    await phone(c, 'gita-1');
    expect((await call('DELETE', '/v1/me', undefined, c.token)).status).toBe(200);
    expect(await tokensOf(c.id)).toEqual([]);
  });
});

describe('Order updates pushed to the customer', () => {
  it('each move the shop makes goes to the customer’s phones only, with the order to open', async () => {
    const c = await customer('Harpreet');
    const other = await customer('Indu');
    await phone(c, 'h-phone');
    await phone(c, 'h-tablet');
    await phone(other, 'indu-phone');
    const number = await order(c, 'cp-flow');
    await pause(50);
    expect(sent).toEqual([]); // placing the order: the customer is looking at it already

    const steps: [string, string, string][] = [
      ['confirmed', `Order confirmed · #${number}`, 'The shop has confirmed your order.'],
      ['packed', `Order packed · #${number}`, 'Your order is packed and will be on its way soon.'],
      ['out_for_delivery', `Out for delivery · #${number}`, 'Your order is on the way.'],
      ['delivered', `Delivered · #${number}`, 'Your order has been delivered. Thank you for shopping with ElectroDash.'],
    ];
    for (const [status, title, body] of steps) {
      sent = [];
      expect((await move(number, status)).status).toBe(200);
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].map((m) => m.to).sort()).toEqual([pushToken('h-phone'), pushToken('h-tablet')]);
      for (const m of sent[0]) {
        expect(m).toEqual({ to: m.to, title, body, data: { type: 'order_update', number }, sound: 'default', priority: 'high', channelId: 'orders' });
      }
    }
  });

  it('a cancel by the shop says why', async () => {
    const c = await customer('Jaspreet');
    await phone(c, 'j-phone');
    const number = await order(c, 'cp-cancel');
    expect((await move(number, 'cancelled', 'Out of stock')).status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0][0]).toMatchObject({ title: `Order #${number} cancelled`, body: 'Out of stock', data: { type: 'order_update', number } });
  });

  it('the customer’s own cancel sends nothing (they just did it)', async () => {
    const c = await customer('Komal');
    await phone(c, 'k-phone');
    const number = await order(c, 'cp-self-cancel');
    expect((await call('POST', `/v1/orders/${number}/cancel`, {}, c.token)).status).toBe(200);
    await pause(100);
    expect(attempts).toBe(0);
  });

  it('a refused move sends nothing', async () => {
    const c = await customer('Lata');
    await phone(c, 'l-phone');
    const number = await order(c, 'cp-refused');
    expect((await move(number, 'delivered')).status).toBe(409);
    await pause(100);
    expect(attempts).toBe(0);
  });

  it('moves from Wall2Roof and from the admin app push too', async () => {
    const c = await customer('Manpreet');
    await phone(c, 'm-phone');
    const number = await order(c, 'cp-others');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/integration/orders/${number}/status`,
      payload: { status: 'confirmed' },
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0][0]).toMatchObject({ to: pushToken('m-phone'), title: `Order confirmed · #${number}` });

    sent = [];
    await h.db.insert(staffAccounts).values({ username: 'packer', name: 'Packer', passwordHash: await hashPassword('packing-2026'), active: true });
    const login = await call('POST', '/v1/staff/auth/login', { username: 'packer', password: 'packing-2026' });
    expect(login.status).toBe(200);
    const r = await call('POST', `/v1/staff/orders/${number}/status`, { status: 'packed' }, login.body.accessToken);
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0][0]).toMatchObject({ to: pushToken('m-phone'), title: `Order packed · #${number}` });
  });

  it('no alerts once the customer is logged out on every phone', async () => {
    const c = await customer('Navneet');
    await phone(c, 'n-phone');
    const number = await order(c, 'cp-logged-out');
    await h.db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.userId, c.id));
    expect((await move(number, 'confirmed')).status).toBe(200);
    await pause(100);
    expect(attempts).toBe(0);
  });

  it('forgets phones whose app was uninstalled', async () => {
    const c = await customer('Om');
    await phone(c, 'o-old');
    await phone(c, 'o-new');
    const number = await order(c, 'cp-gone');
    answer = (m) => m.map((x) => (x.to === pushToken('o-old') ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }));
    expect((await move(number, 'confirmed')).status).toBe(200);
    await vi.waitFor(async () => expect(await tokensOf(c.id)).toEqual([pushToken('o-new')]));
  });

  it('never fails the shop’s change when sending fails', async () => {
    const c = await customer('Pooja');
    await phone(c, 'p-phone');
    const number = await order(c, 'cp-fail');
    fail = true;
    const r = await move(number, 'confirmed');
    expect(r.status).toBe(200);
    await vi.waitFor(() => expect(attempts).toBe(1));
    const d = await call('GET', `/v1/orders/${number}`, undefined, c.token);
    expect(d.body.status).toBe('confirmed');
  });
});
