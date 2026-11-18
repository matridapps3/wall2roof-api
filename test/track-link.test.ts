import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { products } from '../src/db/schema.js';
import { changeOrderStatus } from '../src/routes/orders.js';

let h: DbHandle;
let app: FastifyInstance;
let bulbId: number;
let customer: { token: string; addressId: number };

async function call(method: string, url: string, body?: unknown, auth?: string) {
  const res = await app.inject({ method: method as 'GET', url, payload: body as never, headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

async function placeOrder(key: string) {
  await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 2 }, customer.token);
  const o = await call('POST', '/v1/orders', { addressId: customer.addressId, paymentMethod: 'cod', idempotencyKey: key }, customer.token);
  expect(o.status).toBe(201);
  return o.body.number as string;
}

const open = (path: string) => app.inject({ method: 'GET', url: path });

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [p] = await h.db
    .insert(products)
    .values({ sku: 'B1', slug: 'bulb', name: '9W LED <Bulb>', images: [], pricePaise: 50_000, mrpPaise: 60_000, stockQty: 50 })
    .returning();
  bulbId = p.id;
  const req = await call('POST', '/v1/auth/otp/request', { phone: '9876522222' });
  const ver = await call('POST', '/v1/auth/otp/verify', { phone: '9876522222', code: req.body.devCode });
  const a = await call(
    'POST',
    '/v1/addresses',
    { label: 'home', name: 'Priya Sharma', phone: '9876522222', line1: '962, Sector 82', city: 'Mohali', state: 'Punjab', pincode: '140306' },
    ver.body.accessToken,
  );
  customer = { token: ver.body.accessToken, addressId: a.body.address.id };
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('shared order tracking link', () => {
  it('opens without a login and shows the status, items and town, but not the name, phone, street or prices', async () => {
    const number = await placeOrder('track-link-1');
    const { body: o } = await call('GET', `/v1/orders/${number}`, undefined, customer.token);
    expect(o.trackPath).toMatch(new RegExp(`^/track/${number}/[A-Za-z0-9_-]{22}$`));

    const res = await open(o.trackPath);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-robots-tag']).toContain('noindex');
    const html = res.body;
    expect(html).toContain(`Order #${number}`);
    expect(html).toContain('Order placed');
    expect(html).toContain('9W LED &lt;Bulb&gt;'); // escaped
    expect(html).toContain('× 2');
    expect(html).toContain('Mohali 140306');
    expect(html).toContain('data-final="0"');
    expect(html).toContain('setInterval'); // keeps itself up to date
    for (const secret of ['Priya', '9876522222', 'Sector 82', '₹', '500']) expect(html).not.toContain(secret);
  });

  it('follows the order as the shop moves it, and stops refreshing once delivered', async () => {
    const number = await placeOrder('track-link-2');
    const { body: o } = await call('GET', `/v1/orders/${number}`, undefined, customer.token);
    await changeOrderStatus(h.db, number, 'confirmed');
    await changeOrderStatus(h.db, number, 'packed');
    await changeOrderStatus(h.db, number, 'out_for_delivery');
    let html = (await open(o.trackPath)).body;
    expect(html).toContain('<h1 class="status live">On the way</h1>');
    expect(html.match(/<li class="done/g)).toHaveLength(4);

    await changeOrderStatus(h.db, number, 'delivered');
    html = (await open(o.trackPath)).body;
    expect(html).toContain('<h1 class="status">Delivered</h1>');
    expect(html).toContain('data-final="1"');
    expect(html).not.toContain('setInterval');
  });

  it('refuses a wrong key or another order’s key, and has no link once cancelled', async () => {
    const a = await placeOrder('track-link-3');
    const b = await placeOrder('track-link-4');
    const pathA = (await call('GET', `/v1/orders/${a}`, undefined, customer.token)).body.trackPath as string;
    const keyA = pathA.split('/').pop()!;
    expect((await open(`/track/${a}/${'x'.repeat(22)}`)).statusCode).toBe(404);
    expect((await open(`/track/${b}/${keyA}`)).statusCode).toBe(404);
    expect((await open(`/track/${a}/short`)).statusCode).toBe(404);
    expect((await open(`/track/${a}/${keyA}`)).statusCode).toBe(200);

    await call('POST', `/v1/orders/${a}/cancel`, {}, customer.token);
    const cancelled = (await call('GET', `/v1/orders/${a}`, undefined, customer.token)).body;
    expect(cancelled.trackPath).toBeNull();
    // a link shared before the cancel says so
    const html = (await open(pathA)).body;
    expect(html).toContain('Order cancelled');
    expect(html).toContain('data-final="1"');
  });
});
