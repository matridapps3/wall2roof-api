import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { orders, productReviews, products, settings, supportMessages, users } from '../src/db/schema.js';
import { VoiceStore } from '../src/lib/voice.js';

let h: DbHandle;
let app: FastifyInstance;
let dir: string;
let bulbId: number;

async function call(method: string, url: string, body?: unknown, auth?: string, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as never,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.headers['content-type']?.toString().includes('json') ? (res.json() as any) : res.rawPayload };
}

async function login(phone: string) {
  const req = await call('POST', '/v1/auth/otp/request', { phone });
  const ver = await call('POST', '/v1/auth/otp/verify', { phone, code: req.body.devCode });
  return ver.body as { accessToken: string; refreshToken: string; isNew: boolean; user: { id: number } };
}

/** A customer with an address, a cart, a wishlist item, and an order (with a voice note) not yet delivered. */
async function customer(phone: string, key: string) {
  const s = await login(phone);
  const t = s.accessToken;
  const a = await call('POST', '/v1/addresses', { label: 'home', name: 'Priya Sharma', phone, line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' }, t);
  const up = await call('POST', '/v1/voice-notes', m4a, t, { 'content-type': 'audio/mp4' });
  await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, t);
  const o = await call('POST', '/v1/orders', { addressId: a.body.address.id, paymentMethod: 'cod', idempotencyKey: key, voiceNoteId: up.body.id }, t);
  await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 2 }, t);
  await call('PUT', `/v1/wishlist/${bulbId}`, undefined, t);
  await call('POST', '/v1/support', { topic: 'other', message: 'Please call me back', email: 'priya@example.com', phone }, t);
  return { ...s, orderNumber: o.body.number as string };
}

const m4a = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(200, 1)]);

beforeAll(async () => {
  h = await openDb({ memory: true });
  dir = await mkdtemp(join(tmpdir(), 'ed-delete-'));
  app = await buildApp(h.db, {}, { voice: new VoiceStore(dir) });
  const [p] = await h.db.insert(products).values({ sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 50 }).returning();
  bulbId = p.id;
});

afterAll(async () => {
  await app.close();
  await h.close();
  await rm(dir, { recursive: true, force: true });
});

describe('delete account', () => {
  it('waits until the order on its way is delivered', async () => {
    const c = await customer('9876500011', 'delete-open-1');
    const res = await call('DELETE', '/v1/me', undefined, c.accessToken);
    expect([res.status, res.body.error.code]).toEqual([409, 'open_orders']);
    expect((await call('GET', '/v1/me', undefined, c.accessToken)).status).toBe(200);
    expect((await call('DELETE', '/v1/me')).status).toBe(401);
  });

  it('erases the customer and keeps the order as a sales record without their details', async () => {
    const c = await customer('9876500022', 'delete-done-1');
    const other = await customer('9876500033', 'delete-other-1');
    const [mine] = await h.db.update(orders).set({ status: 'delivered' }).where(eq(orders.number, c.orderNumber)).returning();
    const [theirOrder] = await h.db.select().from(orders).where(eq(orders.number, other.orderNumber));
    await h.db.insert(productReviews).values([
      { productId: bulbId, userId: c.user.id, orderId: mine.id, rating: 1, comment: 'Stopped working' },
      { productId: bulbId, userId: other.user.id, orderId: theirOrder.id, rating: 5 },
    ]);
    await h.db.update(products).set({ ratingAvg: 30, ratingCount: 2 }).where(eq(products.id, bulbId));

    expect((await call('DELETE', '/v1/me', undefined, c.accessToken)).body).toEqual({ ok: true });

    // logged out everywhere; the old session can't come back
    expect((await call('GET', '/v1/me', undefined, c.accessToken)).status).toBe(401);
    expect((await call('POST', '/v1/auth/refresh', { refreshToken: c.refreshToken })).status).toBe(401);
    expect((await call('DELETE', '/v1/me', undefined, c.accessToken)).status).toBe(401);

    const [u] = await h.db.select().from(users).where(eq(users.id, c.user.id));
    expect(u).toMatchObject({ name: 'Deleted customer', phone: null, email: null, passwordHash: null, notifyOffers: false });
    expect(u.deletedAt).toBeInstanceOf(Date);

    const [o] = await h.db.select().from(orders).where(eq(orders.id, mine.id));
    expect(o.address).toMatchObject({ name: 'Deleted customer', phone: '', line1: '', city: 'Mohali', state: 'Punjab', pincode: '140306' });
    expect(o.voiceNote).toBeNull();
    expect(o.totalPaise).toBeGreaterThan(0);
    await expect(access(join(dir, String(c.user.id)))).rejects.toThrow();

    const [msg] = await h.db.select().from(supportMessages).where(eq(supportMessages.userId, c.user.id));
    expect(msg).toMatchObject({ name: 'Deleted customer', email: '', phone: null });

    // their rating no longer counts
    expect(await h.db.$count(productReviews, eq(productReviews.userId, c.user.id))).toBe(0);
    const [p] = await h.db.select().from(products).where(eq(products.id, bulbId));
    expect([p.ratingAvg, p.ratingCount]).toEqual([50, 1]);

    // the same number can sign up again, as a new customer with nothing from before
    const again = await login('9876500022');
    expect(again.isNew).toBe(true);
    expect(again.user.id).not.toBe(c.user.id);
    const me = await call('GET', '/v1/me', undefined, again.accessToken);
    expect(me.body.counts).toEqual({ orders: 0, wishlist: 0, addresses: 0, unreadNotifications: 0 });

    // the other customer is untouched
    const theirs = await call('GET', '/v1/me', undefined, other.accessToken);
    expect(theirs.body.counts).toMatchObject({ orders: 1, wishlist: 1, addresses: 1 });
    await expect(access(join(dir, String(other.user.id)))).resolves.toBeUndefined();
  });
});

describe('privacy and support pages', () => {
  it('are public web pages with the support contact from the settings', async () => {
    await h.db.insert(settings).values([
      { key: 'supportEmail', value: 'help@example.com' },
      { key: 'supportPhone', value: '+91 98765 00000' },
    ]);
    for (const url of ['/privacy', '/support', '/delete-account']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('mailto:help@example.com');
      expect(res.body).toContain('Delete account</strong>');
    }
  });
});
