import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, orderItems, orders, products, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/lib/auth.js';
import { setSetting } from '../src/lib/settings.js';
import { reviewerName } from '../src/lib/reviews.js';
import { cardBadge } from '../src/routes/catalog.js';

let h: DbHandle;
let app: FastifyInstance;
let bulb: number;
let fan: number;
let wire: number;
const tokens: string[] = [];

async function call(method: string, url: string, body?: unknown, token?: string) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    payload: body as object | undefined,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.statusCode, body: res.json() as any };
}

const address = { label: 'home' as const, name: 'Priya', phone: '9876543210', line1: '12 MG Road', city: 'Mohali', state: 'Punjab', pincode: '140306' };
const money = { subtotalPaise: 0, mrpTotalPaise: 0, deliveryFeePaise: 0, handlingFeePaise: 0, totalPaise: 0 };

/** An order for this customer with these products, straight into the database. */
async function order(userId: number, number: string, status: 'delivered' | 'placed' | 'cancelled', productIds: number[], createdAt = new Date()) {
  const [o] = await h.db
    .insert(orders)
    .values({ number, userId, status, address, ...money, paymentMethod: 'cod', idempotencyKey: `key-${number}`, createdAt })
    .returning();
  await h.db.insert(orderItems).values(productIds.map((productId) => ({ orderId: o.id, productId, sku: `S${productId}`, name: `Item ${productId}`, qty: 1, unitPricePaise: 100, unitMrpPaise: 100 })));
  return o;
}

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  await setSetting(h.db, 'writtenReviews', true); // these tests cover the written reviews
  const [cat] = await h.db.insert(categories).values({ slug: 'lights', name: 'Lights' }).returning();
  const [philips, anchor] = await h.db
    .insert(brands)
    .values([
      { slug: 'philips', name: 'Philips', logoUrl: 'https://example.com/philips.png' },
      { slug: 'anchor', name: 'Anchor' },
    ])
    .returning();
  const base = { categoryId: cat.id, images: [] as string[], stockQty: 10, pricePaise: 10_000, mrpPaise: 12_000 };
  const rows = await h.db
    .insert(products)
    .values([
      { ...base, sku: 'B', slug: 'bulb', name: 'LED Bulb', brandId: philips.id },
      { ...base, sku: 'F', slug: 'fan', name: 'Ceiling Fan', brandId: philips.id, isBestseller: true },
      { ...base, sku: 'W', slug: 'wire', name: 'Copper Wire', brandId: anchor.id },
    ])
    .returning();
  [bulb, fan, wire] = rows.map((r) => r.id);

  const people = await h.db
    .insert(users)
    .values([
      { name: 'Priya Sharma', phone: '+919800000001' },
      { name: 'Ravi', phone: '+919800000002' },
      { name: null, phone: '+919800000003' },
    ])
    .returning();
  for (const u of people) tokens.push(await signAccessToken(u.id, 'customer'));
  await order(people[0].id, 'ED-1', 'delivered', [bulb, fan], new Date('2026-10-01'));
  await order(people[0].id, 'ED-2', 'placed', [wire], new Date('2026-10-05'));
  await order(people[0].id, 'ED-3', 'cancelled', [fan], new Date('2026-10-09'));
  // a second delivered order with the bulb in it
  await order(people[0].id, 'ED-6', 'delivered', [bulb], new Date('2026-10-03'));
  await order(people[1].id, 'ED-4', 'delivered', [bulb]);
  await order(people[2].id, 'ED-5', 'delivered', [bulb]);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('rating a delivered order', () => {
  it('only delivered orders, only their own items, only by their customer', async () => {
    expect((await call('POST', '/v1/orders/ED-2/ratings', { ratings: [{ productId: wire, rating: 5 }] }, tokens[0])).status).toBe(409);
    expect((await call('POST', '/v1/orders/ED-1/ratings', { ratings: [{ productId: wire, rating: 5 }] }, tokens[0])).status).toBe(400);
    expect((await call('POST', '/v1/orders/ED-1/ratings', { ratings: [{ productId: bulb, rating: 6 }] }, tokens[0])).status).toBe(400);
    expect((await call('POST', '/v1/orders/ED-4/ratings', { ratings: [{ productId: bulb, rating: 5 }] }, tokens[0])).status).toBe(404);
    expect((await call('POST', '/v1/orders/ED-1/ratings', { ratings: [{ productId: bulb, rating: 5 }] })).status).toBe(401);
  });

  it('saves the stars and words, shows them on the order, and counts them on the product', async () => {
    const list = await call('GET', '/v1/orders', undefined, tokens[0]);
    const before = list.body.orders.find((o: any) => o.number === 'ED-1');
    expect(before).toMatchObject({ canRate: true, myRating: null });
    expect(list.body.orders.find((o: any) => o.number === 'ED-2')).toMatchObject({ canRate: false, myRating: null });

    const r = await call('POST', '/v1/orders/ED-1/ratings', { ratings: [{ productId: bulb, rating: 4, comment: '  Bright and well packed ' }, { productId: fan, rating: 5 }] }, tokens[0]);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => [i.productId, i.myRating, i.myComment])).toEqual([
      [bulb, 4, 'Bright and well packed'],
      [fan, 5, null],
    ]);
    expect(r.body.myRating).toBe(4.5);
    const after = (await call('GET', '/v1/orders', undefined, tokens[0])).body.orders.find((o: any) => o.number === 'ED-1');
    expect(after.myRating).toBe(4.5);

    const card = (await call('GET', '/v1/products?category=lights')).body.items.find((p: any) => p.id === bulb);
    expect(card).toMatchObject({ rating: 4, ratingCount: 1 });
  });

  it('rating the same order again replaces its rating instead of adding one', async () => {
    await call('POST', '/v1/orders/ED-1/ratings', { ratings: [{ productId: bulb, rating: 3, comment: 'Flickers a bit' }] }, tokens[0]);
    const p = (await call('GET', '/v1/products/bulb')).body;
    expect(p.rating).toBe(3);
    expect(p.ratingCount).toBe(1);
    expect(p.reviews.recent).toEqual([{ id: expect.any(Number), name: 'Priya S.', rating: 3, comment: 'Flickers a bit', at: expect.any(String), byYou: false }]);
  });

  it('with written reviews off (the default, like Blinkit) the product page shows only the stars', async () => {
    await setSetting(h.db, 'writtenReviews', false);
    try {
      const p = (await call('GET', '/v1/products/bulb', undefined, tokens[1])).body;
      expect(p.reviews).toEqual({ average: 3, count: 1, stars: [0, 0, 1, 0, 0], recent: [] });
      expect(JSON.stringify(p)).not.toContain('Flickers a bit');
    } finally {
      await setSetting(h.db, 'writtenReviews', true);
    }
  });

  it('the product page sums up everyone’s stars; enough good ratings make it "Top Rated"', async () => {
    await call('POST', '/v1/orders/ED-1/ratings', { ratings: [{ productId: bulb, rating: 5, comment: 'Great' }] }, tokens[0]);
    await call('POST', '/v1/orders/ED-4/ratings', { ratings: [{ productId: bulb, rating: 4 }] }, tokens[1]);
    await call('POST', '/v1/orders/ED-5/ratings', { ratings: [{ productId: bulb, rating: 5, comment: 'Value for money' }] }, tokens[2]);
    const p = (await call('GET', '/v1/products/bulb')).body;
    expect(p.reviews).toMatchObject({ average: 4.7, count: 3, stars: [2, 1, 0, 0, 0] });
    // only reviews with words, newest first; no name falls back to a plain label
    expect(p.reviews.recent.map((r: any) => [r.name, r.comment])).toEqual([
      ['ElectroDash customer', 'Value for money'],
      ['Priya S.', 'Great'],
    ]);
    expect(p).toMatchObject({ rating: 4.7, ratingCount: 3, badge: 'Top Rated' });
    // the fan is the admin's bestseller with one rating: "Bestseller"; the wire has neither
    const cards = (await call('GET', '/v1/products?category=lights')).body.items;
    expect(cards.find((c: any) => c.id === fan).badge).toBe('Bestseller');
    expect(cards.find((c: any) => c.id === wire).badge).toBeNull();
  });

  it('each order is rated on its own; the product counts each customer once, by their latest rating', async () => {
    // the bulb was rated from ED-1, but ED-6 hasn't been rated yet
    const before = (await call('GET', '/v1/orders/ED-6', undefined, tokens[0])).body;
    expect(before).toMatchObject({ canRate: true, myRating: null });
    expect(before.items[0]).toMatchObject({ myRating: null, myComment: null });

    const r = await call('POST', '/v1/orders/ED-6/ratings', { ratings: [{ productId: bulb, rating: 2, comment: 'Stopped working' }] }, tokens[0]);
    expect(r.status).toBe(200);
    expect(r.body.myRating).toBe(2);
    // ED-1 keeps what it was given
    expect((await call('GET', '/v1/orders/ED-1', undefined, tokens[0])).body.items.find((i: any) => i.productId === bulb).myRating).toBe(5);

    // still 3 customers: this one now counts with 2 (their latest), with 4 and 5 from the others
    const p = (await call('GET', '/v1/products/bulb')).body;
    expect(p.reviews).toMatchObject({ average: 3.7, count: 3, stars: [1, 1, 0, 1, 0] });
    expect(p.reviews.recent.map((x: any) => x.comment)).toEqual(['Stopped working', 'Value for money']);
    expect(p).toMatchObject({ rating: 3.7, ratingCount: 3, badge: null });
  });

  it('a product nobody rated has an empty summary', async () => {
    expect((await call('GET', '/v1/products/wire')).body.reviews).toEqual({ average: null, count: 0, stars: [0, 0, 0, 0, 0], recent: [] });
  });
});

describe('buy again, brands and badges', () => {
  it('"Buy again" lists what the customer ordered before, newest first, without cancelled orders', async () => {
    const r = await call('GET', '/v1/me/buy-again', undefined, tokens[0]);
    expect(r.body.items.map((p: any) => p.slug)).toEqual(['wire', 'bulb', 'fan']);
    expect((await call('GET', '/v1/me/buy-again')).status).toBe(401);
  });

  it('Home lists brands with their logos, most products first', async () => {
    const home = (await call('GET', '/v1/home')).body;
    expect(home.brands).toEqual([
      { slug: 'philips', name: 'Philips', logoUrl: 'https://example.com/philips.png', count: 2 },
      { slug: 'anchor', name: 'Anchor', logoUrl: null, count: 1 },
    ]);
  });

  it('the brand filter carries each brand’s logo', async () => {
    const facets = (await call('GET', '/v1/products?category=lights')).body.facets;
    expect(facets.brands[0]).toEqual({ slug: 'philips', name: 'Philips', logoUrl: 'https://example.com/philips.png', count: 2 });
  });

  it('badge rules and reviewer names', () => {
    expect(cardBadge({ ratingAvg: 45, ratingCount: 2, isBestseller: false })).toBeNull();
    expect(cardBadge({ ratingAvg: 42, ratingCount: 10, isBestseller: true })).toBe('Bestseller');
    expect(cardBadge({ ratingAvg: 43, ratingCount: 3, isBestseller: true })).toBe('Top Rated');
    expect(reviewerName('  ravi   kumar singh ')).toBe('ravi S.');
    expect(reviewerName('')).toBe('ElectroDash customer');
  });
});
