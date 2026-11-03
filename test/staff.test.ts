import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { orderEvents, orders, products, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/lib/auth.js';
import { VoiceStore } from '../src/lib/voice.js';
import { changeOrderStatus } from '../src/routes/orders.js';

const KEY = 'test-integration-key-0123456789-abcdefghij';
let h: DbHandle;
let app: FastifyInstance;
let dir: string;
let bulbId: number;
let customer: { token: string; id: number; addressId: number };
let staff: { token: string; id: number };
let adminToken: string;

async function call(method: string, url: string, body?: unknown, auth?: string, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as never,
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
  });
  return { status: res.statusCode, body: res.json() as any };
}

async function login(phone: string) {
  const req = await call('POST', '/v1/auth/otp/request', { phone });
  const ver = await call('POST', '/v1/auth/otp/verify', { phone, code: req.body.devCode });
  expect(ver.status).toBe(200);
  return ver.body as { accessToken: string; refreshToken: string; user: { id: number; role: string } };
}

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
  const c = await login('9876511111');
  await call('PATCH', '/v1/me', { name: 'Priya Sharma' }, c.accessToken);
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name: 'Priya Sharma', phone: '9876511111', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
    c.accessToken,
  );
  customer = { token: c.accessToken, id: c.user.id, addressId: a.body.address.id };
});

afterAll(async () => {
  await app.close();
  await h.close();
  await rm(dir, { recursive: true, force: true });
});

describe('staff role', () => {
  it('sends the role with the user, and a teammate made staff gets it at the next refresh', async () => {
    const s = await login('9876522222');
    expect(s.user.role).toBe('customer');
    expect((await call('GET', '/v1/me', undefined, customer.token)).body.user.role).toBe('customer');
    await call('PATCH', '/v1/me', { name: 'Meena Kumari' }, s.accessToken);

    // what `npm run staff:set -- 9876522222 staff` does
    await h.db.update(users).set({ role: 'staff' }).where(eq(users.id, s.user.id));
    // the login they already had still says customer
    expect((await call('GET', '/v1/staff/orders', undefined, s.accessToken)).status).toBe(403);
    const r = await call('POST', '/v1/auth/refresh', { refreshToken: s.refreshToken });
    expect(r.body.user.role).toBe('staff');
    staff = { token: r.body.accessToken, id: s.user.id };
    expect((await call('GET', '/v1/me', undefined, staff.token)).body.user.role).toBe('staff');
    expect((await call('GET', '/v1/staff/orders', undefined, staff.token)).status).toBe(200);
  });
});

describe('store orders', () => {
  let number: string;
  let second: string;
  let voiceId: string;
  let adminOrder: string;

  beforeAll(async () => {
    voiceId = (await call('POST', '/v1/voice-notes', m4a, customer.token, { 'content-type': 'audio/mp4' })).body.id;
    number = await placeOrder('staff-flow-1', 2, { instructions: ['Call on arrival'], voiceNoteId: voiceId });
    second = await placeOrder('staff-flow-2', 3);
  });

  it('is closed to customers and to people not logged in', async () => {
    const routes: [string, string, unknown?][] = [
      ['GET', '/v1/staff/orders'],
      ['GET', `/v1/staff/orders/${number}`],
      ['POST', `/v1/staff/orders/${number}/status`, { status: 'confirmed' }],
    ];
    for (const [method, url, body] of routes) {
      const r = await call(method, url, body, customer.token);
      expect([r.status, r.body.error.code]).toEqual([403, 'forbidden']);
      expect((await call(method, url, body)).status).toBe(401);
    }
    const [o] = await h.db.select().from(orders).where(eq(orders.number, number));
    expect(o.status).toBe('placed');
  });

  it('lists the orders still to send out, newest first', async () => {
    const mine = (await call('GET', `/v1/orders/${number}`, undefined, customer.token)).body;
    const r = await call('GET', '/v1/staff/orders', undefined, staff.token);
    expect(r.body.orders.map((o: any) => o.number)).toEqual([second, number]);
    expect(r.body.orders[1]).toEqual({
      number,
      status: 'placed',
      createdAt: mine.placedAt,
      itemCount: 2,
      totalPaise: mine.totalPaise,
      paymentMethod: 'cod',
      customerName: 'Priya Sharma',
      customerPhone: '9876511111',
      city: 'Mohali',
      pincode: '140306',
    });
    expect((await call('GET', '/v1/staff/orders?status=placed', undefined, staff.token)).body.orders).toHaveLength(2);
    expect((await call('GET', '/v1/staff/orders?status=delivered', undefined, staff.token)).body.orders).toEqual([]);
    expect((await call('GET', '/v1/staff/orders?status=shipped', undefined, staff.token)).status).toBe(400);
  });

  it('shows the whole order: what to pick, where it goes, the bill and the next steps', async () => {
    const mine = (await call('GET', `/v1/orders/${number}`, undefined, customer.token)).body;
    const r = await call('GET', `/v1/staff/orders/${number}`, undefined, staff.token);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({
      number,
      status: 'placed',
      itemCount: 2,
      paymentMethod: 'cod',
      paymentStatus: 'cod_due',
      customerName: 'Priya Sharma',
      customerPhone: '9876511111',
      address: { name: 'Priya Sharma', phone: '9876511111', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
      deliveryInstructions: ['Call on arrival'],
      voiceNoteUrl: `/voice/${customer.id}/${voiceId}.m4a`,
      items: [{ sku: 'B1', name: '9W LED Bulb', image: 'https://example.com/b1.jpg', qty: 2, unitPricePaise: 50_000 }],
      subtotalPaise: mine.bill.subtotalPaise,
      deliveryFeePaise: mine.bill.deliveryFeePaise,
      handlingFeePaise: mine.bill.handlingFeePaise,
      codFeePaise: mine.bill.codFeePaise,
      discountPaise: 0,
      tipPaise: 0,
      totalPaise: mine.bill.totalPaise,
      gstin: null,
      businessName: null,
      cancelReason: null,
      events: [{ status: 'placed', note: null, at: expect.any(String), by: null }],
      nextStatuses: ['confirmed', 'cancelled'],
    });
    const nf = await call('GET', '/v1/staff/orders/ED-0000-00000', undefined, staff.token);
    expect([nf.status, nf.body.error.code]).toEqual([404, 'not_found']);
  });

  it('moves an order through picked, packed, dispatched and delivered, recording who did it', async () => {
    const steps: [string, string[]][] = [
      ['confirmed', ['packed', 'cancelled']],
      ['packed', ['out_for_delivery', 'cancelled']],
      ['out_for_delivery', ['delivered']],
      ['delivered', []],
    ];
    for (const [status, next] of steps) {
      const r = await call('POST', `/v1/staff/orders/${number}/status`, { status }, staff.token);
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.order).toMatchObject({ number, status, nextStatuses: next });
    }
    const d = (await call('GET', `/v1/staff/orders/${number}`, undefined, staff.token)).body.order;
    expect(d.paymentStatus).toBe('paid'); // cash collected on delivery
    expect(d.events.map((e: any) => [e.status, e.by])).toEqual([
      ['placed', null],
      ['confirmed', 'Meena Kumari'],
      ['packed', 'Meena Kumari'],
      ['out_for_delivery', 'Meena Kumari'],
      ['delivered', 'Meena Kumari'],
    ]);
    const [o] = await h.db.select().from(orders).where(eq(orders.number, number));
    const rows = await h.db.select().from(orderEvents).where(eq(orderEvents.orderId, o.id));
    expect(rows.filter((e) => e.actorUserId === staff.id)).toHaveLength(4);

    // it leaves the active list for the delivered one, and the customer heard about each step
    expect((await call('GET', '/v1/staff/orders', undefined, staff.token)).body.orders.map((x: any) => x.number)).toEqual([second]);
    expect((await call('GET', '/v1/staff/orders?status=delivered', undefined, staff.token)).body.orders.map((x: any) => x.number)).toEqual([number]);
    const titles = (await call('GET', '/v1/notifications', undefined, customer.token)).body.notifications.map((n: any) => n.title);
    for (const t of ['Order confirmed', 'Order packed', 'Out for delivery', 'Delivered']) expect(titles).toContain(`${t} · #${number}`);
  });

  it('refuses a step out of order', async () => {
    const skip = await call('POST', `/v1/staff/orders/${second}/status`, { status: 'delivered' }, staff.token);
    expect([skip.status, skip.body.error.code]).toEqual([409, 'invalid_transition']);
    const back = await call('POST', `/v1/staff/orders/${number}/status`, { status: 'packed' }, staff.token);
    expect([back.status, back.body.error.code]).toEqual([409, 'invalid_transition']);
    expect((await call('POST', `/v1/staff/orders/${second}/status`, { status: 'placed' }, staff.token)).status).toBe(400);
    expect((await call('POST', '/v1/staff/orders/ED-0000-00000/status', { status: 'confirmed' }, staff.token)).status).toBe(404);
  });

  it('cancels only with a reason, and puts the stock back', async () => {
    for (const body of [{ status: 'cancelled' }, { status: 'cancelled', note: '   ' }]) {
      const r = await call('POST', `/v1/staff/orders/${second}/status`, body, staff.token);
      expect([r.status, r.body.error.code]).toEqual([400, 'reason_required']);
    }
    const [before] = await h.db.select().from(products).where(eq(products.id, bulbId));
    const r = await call('POST', `/v1/staff/orders/${second}/status`, { status: 'cancelled', note: 'Customer called to cancel' }, staff.token);
    expect(r.status).toBe(200);
    expect(r.body.order).toMatchObject({ status: 'cancelled', cancelReason: 'Customer called to cancel', nextStatuses: [] });
    expect(r.body.order.events.at(-1)).toMatchObject({ status: 'cancelled', note: 'Customer called to cancel', by: 'Meena Kumari' });
    const [after] = await h.db.select().from(products).where(eq(products.id, bulbId));
    expect(after.stockQty).toBe(before.stockQty + 3);
  });

  it('lets an admin in too; the admin route and Wall2Roof still work and say who moved the order', async () => {
    const [admin] = await h.db.insert(users).values({ name: 'Owner', email: 'owner@example.com', role: 'admin' }).returning();
    adminToken = await signAccessToken(admin.id, 'admin');
    const n = await placeOrder('staff-admin-1', 1);
    adminOrder = n;
    expect((await call('GET', '/v1/staff/orders', undefined, adminToken)).body.orders.map((x: any) => x.number)).toEqual([n]);
    expect((await call('POST', `/v1/staff/orders/${n}/status`, { status: 'confirmed' }, adminToken)).body.order.events.at(-1).by).toBe('Owner');
    expect((await call('POST', `/v1/admin/orders/${n}/status`, { status: 'packed' }, adminToken)).body).toEqual({ ok: true });
    // staff can't use the admin route
    expect((await call('POST', `/v1/admin/orders/${n}/status`, { status: 'out_for_delivery' }, staff.token)).status).toBe(403);
    const w2r = await app.inject({
      method: 'POST',
      url: `/v1/integration/orders/${n}/status`,
      payload: { status: 'out_for_delivery' },
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(w2r.json()).toEqual({ ok: true });
    // a staff member with no name shows as their phone
    const [noName] = await h.db.insert(users).values({ phone: '9876533333', role: 'staff' }).returning();
    await call('POST', `/v1/staff/orders/${n}/status`, { status: 'delivered' }, await signAccessToken(noName.id, 'staff'));

    const d = (await call('GET', `/v1/staff/orders/${n}`, undefined, staff.token)).body.order;
    expect(d.events.map((e: any) => e.by)).toEqual([null, 'Owner', 'Owner', 'Wall2Roof admin', '9876533333']);
    // Wall2Roof's own order JSON is as it was
    const full = await app.inject({ method: 'GET', url: `/v1/integration/orders/${n}`, headers: { authorization: `Bearer ${KEY}` } });
    expect(full.json().events.map((e: any) => Object.keys(e).sort())).toEqual(Array(5).fill(['created_at', 'note', 'status']));
  });

  it('never shows the customer who moved their order', async () => {
    const d = (await call('GET', `/v1/orders/${number}`, undefined, customer.token)).body;
    expect(d.timeline.map((e: any) => e.status)).toEqual(['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered']);
    for (const e of d.timeline) expect(Object.keys(e).sort()).toEqual(['at', 'note', 'status']);
    const seen = JSON.stringify([
      d,
      (await call('GET', '/v1/orders', undefined, customer.token)).body,
      (await call('GET', '/v1/notifications', undefined, customer.token)).body,
    ]);
    for (const who of ['Meena', '9876522222', '9876533333', 'Owner', 'Wall2Roof']) expect(seen).not.toContain(who);
  });

  it('drops a staff member from the order history when they delete their account', async () => {
    expect((await call('DELETE', '/v1/me', undefined, staff.token)).status).toBe(200);
    const d = (await call('GET', `/v1/staff/orders/${number}`, undefined, adminToken)).body.order;
    expect(d.events.map((e: any) => e.by)).toEqual([null, null, null, null, null]);
    expect(await h.db.$count(orderEvents, eq(orderEvents.actorUserId, staff.id))).toBe(0);
    // everyone else's steps keep their names
    const kept = (await call('GET', `/v1/staff/orders/${adminOrder}`, undefined, adminToken)).body.order;
    expect(kept.events.map((e: any) => e.by)).toEqual([null, 'Owner', 'Owner', 'Wall2Roof admin', '9876533333']);
  });

  it('lets only one of two changes made at once go through, so stock goes back once', async () => {
    const stock = async () => (await h.db.select().from(products).where(eq(products.id, bulbId)))[0].stockQty;
    const statusOf = async (n: string) => (await h.db.select().from(orders).where(eq(orders.number, n)))[0].status;
    const eventsOf = async (n: string) => (await call('GET', `/v1/staff/orders/${n}`, undefined, adminToken)).body.order.events.map((e: any) => e.status);

    // two phones cancel the same order: one cancel, one restock
    const a = await placeOrder('staff-race-1', 2);
    const before = await stock();
    const twice = await Promise.allSettled([changeOrderStatus(h.db, a, 'cancelled', 'Out of stock'), changeOrderStatus(h.db, a, 'cancelled', 'Out of stock')]);
    expect(twice.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(twice.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'invalid_transition' } });
    expect(await stock()).toBe(before + 2);
    expect(await eventsOf(a)).toEqual(['placed', 'cancelled']);

    // one marks it picked while another cancels: whichever is first wins, the other is refused
    const b = await placeOrder('staff-race-2', 2);
    const mid = await stock();
    const both = await Promise.allSettled([changeOrderStatus(h.db, b, 'confirmed'), changeOrderStatus(h.db, b, 'cancelled', 'Out of stock')]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const now = await statusOf(b);
    expect(await eventsOf(b)).toEqual(['placed', now]);
    expect(await stock()).toBe(mid + (now === 'cancelled' ? 2 : 0));
  });
});
