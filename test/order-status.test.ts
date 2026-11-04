import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { orderEvents, orders, products } from '../src/db/schema.js';
import { changeOrderStatus } from '../src/routes/orders.js';

let h: DbHandle;
let app: FastifyInstance;
let bulbId: number;
let customer: { token: string; addressId: number };

async function call(method: string, url: string, body?: unknown, auth?: string) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as never,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
  return { status: res.statusCode, body: res.json() as any };
}

/** The customer orders `qty` bulbs, cash on delivery. */
async function placeOrder(key: string, qty = 2) {
  await call('PUT', '/v1/cart/items', { productId: bulbId, qty }, customer.token);
  const o = await call('POST', '/v1/orders', { addressId: customer.addressId, paymentMethod: 'cod', idempotencyKey: key }, customer.token);
  expect(o.status).toBe(201);
  return o.body.number as string;
}

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [p] = await h.db
    .insert(products)
    .values({ sku: 'B1', slug: 'bulb', name: '9W LED Bulb', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 50 })
    .returning();
  bulbId = p.id;
  const req = await call('POST', '/v1/auth/otp/request', { phone: '9876511111' });
  const ver = await call('POST', '/v1/auth/otp/verify', { phone: '9876511111', code: req.body.devCode });
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name: 'Priya Sharma', phone: '9876511111', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
    ver.body.accessToken,
  );
  customer = { token: ver.body.accessToken, addressId: a.body.address.id };
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('order status changes', () => {
  it('lets only one of two changes made at once go through, so stock goes back once', async () => {
    const stock = async () => (await h.db.select().from(products).where(eq(products.id, bulbId)))[0].stockQty;
    const orderOf = async (n: string) => (await h.db.select().from(orders).where(eq(orders.number, n)))[0];
    const eventsOf = async (n: string) =>
      (await h.db.select().from(orderEvents).where(eq(orderEvents.orderId, (await orderOf(n)).id)).orderBy(asc(orderEvents.id))).map((e) => e.status);

    // the same order cancelled twice at once (Wall2Roof and the admin route): one cancel, one restock
    const a = await placeOrder('status-race-1', 2);
    const before = await stock();
    const twice = await Promise.allSettled([changeOrderStatus(h.db, a, 'cancelled', 'Out of stock'), changeOrderStatus(h.db, a, 'cancelled', 'Out of stock')]);
    expect(twice.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(twice.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'invalid_transition' } });
    expect(await stock()).toBe(before + 2);
    expect(await eventsOf(a)).toEqual(['placed', 'cancelled']);

    // one confirms it while another cancels: whichever is first wins, the other is refused
    const b = await placeOrder('status-race-2', 2);
    const mid = await stock();
    const both = await Promise.allSettled([changeOrderStatus(h.db, b, 'confirmed'), changeOrderStatus(h.db, b, 'cancelled', 'Out of stock')]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const now = (await orderOf(b)).status;
    expect(await eventsOf(b)).toEqual(['placed', now]);
    expect(await stock()).toBe(mid + (now === 'cancelled' ? 2 : 0));
  });
});
