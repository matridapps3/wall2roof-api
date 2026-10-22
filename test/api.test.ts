import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { banners, brands, categories, coupons, homeSections, otpCodes, products, users } from '../src/db/schema.js';
import { setSetting } from '../src/lib/settings.js';
import { signAccessToken } from '../src/lib/auth.js';

let h: DbHandle;
let app: FastifyInstance;
let bulbId: number;
let mcbId: number;
let soldOutId: number;

async function call(method: string, url: string, body?: unknown, token?: string) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as object | undefined,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.json() as any };
}

async function otpLogin(phone: string) {
  const req = await call('POST', '/v1/auth/otp/request', { phone });
  expect(req.status).toBe(200);
  const ver = await call('POST', '/v1/auth/otp/verify', { phone, code: req.body.devCode });
  expect(ver.status).toBe(200);
  return ver.body as { accessToken: string; refreshToken: string; isNew: boolean; user: { id: number } };
}

/** Pretend earlier OTPs were sent a minute ago, to get past the resend limit in tests. */
async function ageOtps(phone: string) {
  await h.db.update(otpCodes).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(otpCodes.phone, phone));
}

const address = {
  label: 'home',
  name: 'Priya Sharma',
  phone: '+91 98765 43210',
  line1: 'Flat 304, Lakeview Residency',
  line2: '27th Main Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560102',
};

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [cat] = await h.db.insert(categories).values({ slug: 'led-bulbs', name: 'LED Bulbs' }).returning();
  const [br] = await h.db.insert(brands).values({ slug: 'philips', name: 'Philips' }).returning();
  const base = { brandId: br.id, categoryId: cat.id, images: [] as string[] };
  const rows = await h.db
    .insert(products)
    .values([
      { ...base, sku: 'B1', slug: 'bulb', name: '9W LED Bulb', pricePaise: 9900, mrpPaise: 15000, stockQty: 5, isBestseller: true },
      { ...base, sku: 'M1', slug: 'mcb', name: '32A MCB', pricePaise: 24900, mrpPaise: 38000, stockQty: 1 },
      { ...base, sku: 'S1', slug: 'sold-out', name: 'Inverter Bulb', pricePaise: 34900, mrpPaise: 69900, stockQty: 0 },
    ])
    .returning();
  [bulbId, mcbId, soldOutId] = rows.map((r) => r.id);
  await h.db.insert(coupons).values({
    code: 'DASH20',
    title: '20% off',
    type: 'percent',
    value: 20,
    maxDiscountPaise: 10000,
    minOrderPaise: 29900,
    firstOrderOnly: true,
  });
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('catalogue', () => {
  it('lists, searches and hides nothing it shouldn’t', async () => {
    await h.db.insert(categories).values({ slug: 'empty-cat', name: 'Empty' });
    const cats = await call('GET', '/v1/categories');
    // The empty category is hidden; only categories with products are listed.
    expect(cats.body.categories).toEqual([expect.objectContaining({ slug: 'led-bulbs', productCount: 3, totalCount: 3 })]);

    const list = await call('GET', '/v1/products?category=led-bulbs');
    expect(list.body.total).toBe(3);
    expect(list.body.items[0].inStock).toBe(true); // in-stock first
    expect(list.body.facets.brands).toEqual([{ slug: 'philips', name: 'Philips', logoUrl: null, count: 3 }]);

    const search = await call('GET', '/v1/products?q=led%20bulb');
    // the bulb named 'LED Bulb' first; the rest of the 'LED Bulbs' category after it
    expect(search.body.items.map((p: any) => p.sku)[0]).toBe('B1');
    expect(search.body.total).toBe(3);

    const detail = await call('GET', '/v1/products/bulb');
    expect(detail.body).toMatchObject({ sku: 'B1', discountPct: 34, brand: 'Philips', brandSlug: 'philips', brandLogoUrl: null });
    expect((await call('GET', '/v1/products/nope')).status).toBe(404);
  });

  it('checks PIN code serviceability against settings', async () => {
    expect((await call('GET', '/v1/serviceability?pincode=560102')).body.serviceable).toBe(true);
    await setSetting(h.db, 'serviceablePincodes', ['560102']);
    expect((await call('GET', '/v1/serviceability?pincode=110001')).body.serviceable).toBe(false);
    expect((await call('GET', '/v1/serviceability?pincode=560102')).body.serviceable).toBe(true);
    expect((await call('GET', '/v1/serviceability?pincode=12')).status).toBe(400);
  });

  it('picks home bestsellers in a random order, only from in-stock bestsellers', async () => {
    const [cat] = await h.db.insert(categories).values({ slug: 'best-pool', name: 'Pool' }).returning();
    await h.db.insert(products).values(
      Array.from({ length: 20 }, (_, i) => ({
        sku: `BP${i}`, slug: `best-${i}`, name: `Bestseller ${i}`, categoryId: cat.id, pricePaise: 1000, mrpPaise: 1000, stockQty: 5, isBestseller: true,
      })),
    );
    const orders = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const best = (await call('GET', '/v1/home')).body.bestsellers as { sku: string; inStock: boolean }[];
      expect(best.length).toBe(12);
      expect(best.every((p) => p.inStock)).toBe(true);
      orders.add(best.map((p) => p.sku).join(','));
    }
    expect(orders.size).toBeGreaterThan(1); // 6 loads of 12 out of 21 can't all come out the same
  });

  it('exposes delivery settings as data', async () => {
    await setSetting(h.db, 'deliveryEtaText', '12 minutes');
    expect((await call('GET', '/v1/config')).body.deliveryEtaText).toBe('12 minutes');
  });

  it('tells older apps about a newer APK only when both version and an https link are set', async () => {
    expect((await call('GET', '/v1/config')).body.latestApp).toBeNull();
    await setSetting(h.db, 'latestAppVersion', '1.1.0');
    expect((await call('GET', '/v1/config')).body.latestApp).toBeNull(); // no link yet
    await setSetting(h.db, 'latestAppUrl', 'http://example.com/app.apk');
    expect((await call('GET', '/v1/config')).body.latestApp).toBeNull(); // not https
    await setSetting(h.db, 'latestAppUrl', 'https://expo.dev/artifacts/eas/x.apk');
    expect((await call('GET', '/v1/config')).body.latestApp).toEqual({ version: '1.1.0', url: 'https://expo.dev/artifacts/eas/x.apk' });
    await setSetting(h.db, 'latestAppVersion', '');
  });

  it('shows live home banners in order, and drops links to hidden things', async () => {
    const img = (n: number) => `https://admin.example.com/uploads/electrodash/banners/b${n}.jpg`;
    const hour = 3_600_000;
    await h.db.insert(categories).values({ slug: 'hidden-cat', name: 'Hidden', isActive: false });
    await h.db.insert(banners).values([
      { title: 'Second', imageUrl: img(2), sort: 2, linkType: 'product', linkTarget: 'bulb' },
      { title: 'First', imageUrl: img(1), sort: 1, linkType: 'category', linkTarget: 'led-bulbs' },
      { title: 'Offers', imageUrl: img(3), sort: 3, linkType: 'offers' },
      { title: 'Hidden category', imageUrl: img(4), sort: 4, linkType: 'category', linkTarget: 'hidden-cat' },
      { title: 'Switched off', imageUrl: img(5), sort: 0, isActive: false },
      { title: 'Not started', imageUrl: img(6), sort: 0, startsAt: new Date(Date.now() + hour) },
      { title: 'Ended', imageUrl: img(7), sort: 0, endsAt: new Date(Date.now() - hour) },
    ]);

    const home = await call('GET', '/v1/home');
    expect(home.status).toBe(200);
    expect(home.body.banners).toEqual([
      { id: expect.any(Number), title: 'First', imageUrl: img(1), link: { type: 'category', target: 'led-bulbs' } },
      { id: expect.any(Number), title: 'Second', imageUrl: img(2), link: { type: 'product', target: 'bulb' } },
      { id: expect.any(Number), title: 'Offers', imageUrl: img(3), link: { type: 'offers', target: null } },
      { id: expect.any(Number), title: 'Hidden category', imageUrl: img(4), link: null },
    ]);
  });

  it('shows live home sections with their shown categories in the admin’s order', async () => {
    const [led] = await h.db.select().from(categories).where(eq(categories.slug, 'led-bulbs'));
    const [empty, hidden, parent] = await h.db
      .insert(categories)
      .values([
        { slug: 'sec-empty', name: 'Nothing in it' },
        { slug: 'sec-hidden', name: 'Hidden', isActive: false },
        { slug: 'sec-parent', name: 'Lighting', imageUrl: 'https://admin.example.com/lighting.png', tint: '#EEF5FD' },
      ])
      .returning();
    // the parent has no products of its own, but its subcategory does
    const [child] = await h.db.insert(categories).values({ slug: 'sec-child', name: 'Panels', parentId: parent.id }).returning();
    await h.db.insert(products).values({ sku: 'P1', slug: 'panel', name: '12W Panel', categoryId: child.id, pricePaise: 49900, mrpPaise: 59900, stockQty: 4 });
    await h.db.insert(homeSections).values([
      { title: 'Season change', subtitle: 'Picked for you', sort: 1, categoryIds: [hidden.id, led.id, empty.id, 999_999, parent.id] },
      { title: 'First', sort: 0, categoryIds: [parent.id] },
      { title: 'Switched off', sort: 0, categoryIds: [led.id], isActive: false },
      { title: 'Nothing to show', sort: 2, categoryIds: [empty.id, hidden.id] },
    ]);

    const home = await call('GET', '/v1/home');
    const lighting = { slug: 'sec-parent', name: 'Lighting', imageUrl: 'https://admin.example.com/lighting.png', tint: '#EEF5FD' };
    expect(home.body.sections).toEqual([
      { id: expect.any(Number), title: 'First', subtitle: null, categories: [lighting] },
      {
        id: expect.any(Number),
        title: 'Season change',
        subtitle: 'Picked for you',
        categories: [{ slug: 'led-bulbs', name: 'LED Bulbs', imageUrl: null, tint: null }, lighting],
      },
    ]);
  });
});

describe('auth', () => {
  it('test login (live server while the app is built) fills in the code like development, and says so', async () => {
    const before = config.OTP_PROVIDER;
    config.OTP_PROVIDER = 'test';
    try {
      expect((await call('GET', '/health')).body.login).toBe('test');
      const req = await call('POST', '/v1/auth/otp/request', { phone: '9811122233' });
      expect(req.status).toBe(200);
      expect(req.body.devCode).toMatch(/^\d{6}$/);
      expect((await call('POST', '/v1/auth/otp/verify', { phone: '9811122233', code: req.body.devCode })).status).toBe(200);
    } finally {
      config.OTP_PROVIDER = before;
    }
  });

  it('the testLogin setting turns on test login even with a real SMS provider configured', async () => {
    const before = config.OTP_PROVIDER;
    config.OTP_PROVIDER = 'msg91'; // no MSG91 key in tests, so a real send would fail
    try {
      await setSetting(h.db, 'testLogin', true);
      expect((await call('GET', '/health')).body.login).toBe('test');
      const req = await call('POST', '/v1/auth/otp/request', { phone: '9811100011' });
      expect(req.status).toBe(200);
      expect(req.body.devCode).toMatch(/^\d{6}$/);

      await setSetting(h.db, 'testLogin', false);
      expect((await call('GET', '/health')).body.login).toBe('sms');
      const real = await call('POST', '/v1/auth/otp/request', { phone: '9811100022' });
      expect(real.status).toBe(500); // tries MSG91, which isn't set up here
      expect(real.body.devCode).toBeUndefined();
    } finally {
      config.OTP_PROVIDER = before;
      await setSetting(h.db, 'testLogin', false);
    }
  });

  it('logs in with OTP and creates the account on first use', async () => {
    const s = await otpLogin('9876543210');
    expect(s.isNew).toBe(true);
    await ageOtps('9876543210'); // skip the 30-second resend wait
    const again = await otpLogin('+91 98765 43210'); // same number, other format
    expect(again.isNew).toBe(false);
    expect(again.user.id).toBe(s.user.id);
  });

  it('rate-limits OTP requests and rejects wrong codes', async () => {
    const first = await call('POST', '/v1/auth/otp/request', { phone: '9123456780' });
    expect(first.status).toBe(200);
    expect((await call('POST', '/v1/auth/otp/request', { phone: '9123456780' })).status).toBe(429);
    const wrong = first.body.devCode === '000000' ? '111111' : '000000';
    const bad = await call('POST', '/v1/auth/otp/verify', { phone: '9123456780', code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('otp_wrong');
  });

  it('rejects invalid phone numbers', async () => {
    expect((await call('POST', '/v1/auth/otp/request', { phone: '12345' })).status).toBe(400);
  });

  it('registers and logs in with email and password', async () => {
    const reg = await call('POST', '/v1/auth/register', { name: 'Asha', email: 'Asha@Example.com', password: 'Electric9' });
    expect(reg.status).toBe(200);
    expect((await call('POST', '/v1/auth/register', { name: 'A', email: 'asha@example.com', password: 'Electric9' })).status).toBe(409);
    expect((await call('POST', '/v1/auth/login', { email: 'asha@example.com', password: 'wrong-pass1' })).status).toBe(401);
    const ok = await call('POST', '/v1/auth/login', { email: 'asha@example.com', password: 'Electric9' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe('asha@example.com');
  });

  it('rejects weak passwords', async () => {
    const r = await call('POST', '/v1/auth/register', { name: 'B', email: 'b@example.com', password: 'short' });
    expect(r.status).toBe(400);
  });

  it('keeps the customer logged in when a refresh reply is lost, and only logout ends it', async () => {
    const s = await otpLogin('9988776655');
    const refresh = (token: string) => call('POST', '/v1/auth/refresh', { refreshToken: token });

    const lost = await refresh(s.refreshToken); // this reply "never reaches the phone"
    expect(lost.status).toBe(200);
    const r1 = await refresh(s.refreshToken); // the phone tries again with the token it still has
    expect(r1.status).toBe(200);
    expect((await refresh(lost.body.refreshToken)).status).toBe(401); // the unused one was retired

    const r2 = await refresh(r1.body.refreshToken); // the phone uses its new token…
    expect(r2.status).toBe(200);
    expect((await refresh(s.refreshToken)).status).toBe(401); // …so the first one is finished

    await call('POST', '/v1/auth/logout', { refreshToken: r2.body.refreshToken });
    expect((await refresh(r2.body.refreshToken)).status).toBe(401);
  });

  it('requires login for account routes', async () => {
    expect((await call('GET', '/v1/me')).status).toBe(401);
    expect((await call('GET', '/v1/me', undefined, 'not-a-token')).status).toBe(401);
  });
});

describe('cart, checkout and orders', () => {
  let token: string;
  let addressId: number;

  beforeAll(async () => {
    token = (await otpLogin('9000000001')).accessToken;
    const a = await call('POST', '/v1/addresses', address, token);
    expect(a.status).toBe(201);
    expect(a.body.address).toMatchObject({ isDefault: true, phone: '9876543210' });
    addressId = a.body.address.id;
  });

  it('prices a guest cart without logging in', async () => {
    const q = await call('POST', '/v1/cart/quote', { items: [{ productId: bulbId, qty: 2 }], couponCode: 'dash20' });
    expect(q.body.subtotalPaise).toBe(19800);
    expect(q.body.coupon).toMatchObject({ applied: false, reason: 'Add ₹101 more to use this coupon.' });
  });

  it('lists coupons with eligibility for the cart', async () => {
    const c = await call('POST', '/v1/coupons', { items: [{ productId: bulbId, qty: 4 }] });
    expect(c.body.coupons[0]).toMatchObject({ code: 'DASH20', eligible: true, savingPaise: 7920 });
  });

  it('merges the guest cart at login and blocks sold-out items', async () => {
    const m = await call('POST', '/v1/cart/merge', { items: [{ productId: bulbId, qty: 3 }, { productId: soldOutId, qty: 1 }] }, token);
    expect(m.body.blocking).toBe(true);
    const order = await call(
      'POST',
      '/v1/orders',
      { addressId, paymentMethod: 'cod', idempotencyKey: 'key-blocked-1' },
      token,
    );
    expect(order.status).toBe(409);
    expect(order.body.error.code).toBe('cart_changed');
    await call('PUT', '/v1/cart/items', { productId: soldOutId, qty: 0 }, token);
  });

  it('replaces the account cart with the device cart', async () => {
    const r = await call('PUT', '/v1/cart', { items: [{ productId: bulbId, qty: 3 }, { productId: 999999, qty: 1 }] }, token);
    expect(r.status).toBe(200);
    expect(r.body.lines).toEqual([expect.objectContaining({ productId: bulbId, qty: 3, issue: null })]);
  });

  it('refuses online payment until a gateway is configured', async () => {
    const r = await call('POST', '/v1/orders', { addressId, paymentMethod: 'online', idempotencyKey: 'key-online-1' }, token);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('payment_unavailable');
  });

  it('refuses a coupon the cart no longer qualifies for, instead of silently dropping it', async () => {
    // 3 × ₹99 = ₹297, below DASH20's ₹299 minimum.
    const r = await call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', couponCode: 'DASH20', idempotencyKey: 'key-coupon-1' }, token);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'coupon_invalid', message: 'Add ₹2 more to use this coupon.' });
  });

  it('places a COD order and decrements stock', async () => {
    const body = { addressId, paymentMethod: 'cod', instructions: ['Leave at door'], idempotencyKey: 'key-order-1' };
    const first = await call('POST', '/v1/orders', body, token);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'placed', paymentStatus: 'cod_due', itemCount: 3, deliveryInstructions: ['Leave at door'] });
    expect(first.body.number).toMatch(/^ED-\d{4}-\d{5}$/);
    expect(first.body.bill).toMatchObject({ subtotalPaise: 29700, deliveryFeePaise: 0, handlingFeePaise: 500, codFeePaise: 1000, totalPaise: 31200 });
    const [bulb] = await h.db.select().from(products).where(eq(products.id, bulbId));
    expect(bulb.stockQty).toBe(2);
    const cart = await call('GET', '/v1/cart', undefined, token);
    expect(cart.body.itemCount).toBe(0);
  });
});

describe('order lifecycle', () => {
  let token: string;
  let addressId: number;
  let number: string;

  beforeAll(async () => {
    token = (await otpLogin('9000000002')).accessToken;
    addressId = (await call('POST', '/v1/addresses', address, token)).body.address.id;
    await call('PUT', '/v1/cart/items', { productId: mcbId, qty: 1 }, token);
    await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 1 }, token);
    const o = await call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', couponCode: 'DASH20', idempotencyKey: 'lifecycle-1' }, token);
    expect(o.status).toBe(201);
    number = o.body.number;
  });

  it('applies the first-order coupon and the COD fee from settings', async () => {
    const o = await call('GET', `/v1/orders/${number}`, undefined, token);
    // ₹249 + ₹99 = ₹348; 20% = ₹69.60 → 6960; free delivery ≥ ₹199; handling ₹5; COD ₹10
    expect(o.body.bill).toMatchObject({ subtotalPaise: 34800, discountPaise: 6960, deliveryFeePaise: 0, codFeePaise: 1000 });
    expect(o.body.bill.totalPaise).toBe(34800 - 6960 + 500 + 1000);
  });

  it('returns the same order for a repeated submit', async () => {
    const again = await call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', idempotencyKey: 'lifecycle-1' }, token);
    expect(again.body.number).toBe(number);
  });

  it('hides orders from other customers', async () => {
    const other = (await otpLogin('9000000003')).accessToken;
    expect((await call('GET', `/v1/orders/${number}`, undefined, other)).status).toBe(404);
  });

  it('took the last MCB out of stock, and cancelling puts it back', async () => {
    let [mcb] = await h.db.select().from(products).where(eq(products.id, mcbId));
    expect(mcb.stockQty).toBe(0);
    const c = await call('POST', `/v1/orders/${number}/cancel`, { reason: 'Ordered by mistake' }, token);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe('cancelled');
    [mcb] = await h.db.select().from(products).where(eq(products.id, mcbId));
    expect(mcb.stockQty).toBe(1);
    expect((await call('POST', `/v1/orders/${number}/cancel`, {}, token)).status).toBe(409);
  });

  it('only admins can move orders along, and only forwards', async () => {
    await call('PUT', '/v1/cart/items', { productId: bulbId, qty: 2 }, token);
    const o = await call('POST', '/v1/orders', { addressId, paymentMethod: 'cod', idempotencyKey: 'lifecycle-2' }, token);
    const n = o.body.number;
    expect((await call('POST', `/v1/admin/orders/${n}/status`, { status: 'confirmed' }, token)).status).toBe(403);

    const [admin] = await h.db.insert(users).values({ email: 'ops@example.com', role: 'admin' }).returning();
    const adminToken = await signAccessToken(admin.id, 'admin');
    expect((await call('POST', `/v1/admin/orders/${n}/status`, { status: 'delivered' }, adminToken)).status).toBe(409);
    for (const status of ['confirmed', 'packed', 'out_for_delivery', 'delivered']) {
      expect((await call('POST', `/v1/admin/orders/${n}/status`, { status }, adminToken)).status).toBe(200);
    }
    const d = await call('GET', `/v1/orders/${n}`, undefined, token);
    expect(d.body.timeline.map((e: any) => e.status)).toEqual(['placed', 'confirmed', 'packed', 'out_for_delivery', 'delivered']);
    expect(d.body.paymentStatus).toBe('paid');
    expect(d.body.canCancel).toBe(false);
    expect(d.body.items[0].canReturn).toBe(true);
    expect(d.body.items[0]).toHaveProperty('unitLabel', null); // the test bulb has no pack size
    expect(d.body.deliveredAt).toEqual(expect.any(String));

    // the list says when each order was delivered (for "Arrived in …"); undelivered ones say null
    const list = (await call('GET', '/v1/orders', undefined, token)).body.orders;
    const mine = list.find((x: any) => x.number === n);
    expect(mine.deliveredAt).toBe(d.body.deliveredAt);
    expect(new Date(mine.deliveredAt).getTime()).toBeGreaterThanOrEqual(new Date(mine.placedAt).getTime());
    expect(list.filter((x: any) => x.status !== 'delivered').every((x: any) => x.deliveredAt === null)).toBe(true);

    const ret = await call(
      'POST',
      `/v1/orders/${n}/returns`,
      { items: [{ orderItemId: d.body.items[0].id, qty: 1 }], reason: 'defective', resolution: 'replacement' },
      token,
    );
    expect(ret.status).toBe(201);

    const notes = await call('GET', '/v1/notifications', undefined, token);
    expect(notes.body.notifications.length).toBeGreaterThan(3);
  });
});
