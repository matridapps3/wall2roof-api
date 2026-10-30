import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { categories, orderItems, orders, productReviews, products, reviewReports, userBlocks, users } from '../src/db/schema.js';
import { signAccessToken } from '../src/lib/auth.js';
import { setSetting } from '../src/lib/settings.js';
import { hasBlockedWords } from '../src/lib/moderation.js';

const KEY = 'test-integration-key-0123456789-abcdefghij';
let h: DbHandle;
let app: FastifyInstance;
let bulb: number;
const ids: number[] = [];
const tokens: string[] = [];

async function call(method: string, url: string, body?: unknown, token?: string, key?: string) {
  const auth = key ? `Bearer ${key}` : token ? `Bearer ${token}` : undefined;
  const res = await app.inject({ method: method as 'GET', url, payload: body as object | undefined, headers: auth ? { authorization: auth } : {} });
  return { status: res.statusCode, body: res.json() as any };
}

const address = { label: 'home' as const, name: 'Priya', phone: '9876543210', line1: '12 MG Road', city: 'Mohali', state: 'Punjab', pincode: '140306' };
const money = { subtotalPaise: 0, mrpTotalPaise: 0, deliveryFeePaise: 0, handlingFeePaise: 0, totalPaise: 0 };

async function deliveredOrder(userId: number, number: string) {
  const [o] = await h.db.insert(orders).values({ number, userId, status: 'delivered', address, ...money, paymentMethod: 'cod', idempotencyKey: `key-${number}` }).returning();
  await h.db.insert(orderItems).values({ orderId: o.id, productId: bulb, sku: 'B', name: 'LED Bulb', qty: 1, unitPricePaise: 100, unitMrpPaise: 100 });
}

const product = async (token?: string) => (await call('GET', '/v1/products/bulb', undefined, token)).body.reviews;

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { integrationKey: KEY });
  await setSetting(h.db, 'writtenReviews', true); // these tests cover the written reviews
  const [cat] = await h.db.insert(categories).values({ slug: 'lights', name: 'Lights' }).returning();
  [{ id: bulb }] = await h.db
    .insert(products)
    .values({ sku: 'B', slug: 'bulb', name: 'LED Bulb', categoryId: cat.id, images: [], stockQty: 10, pricePaise: 10_000, mrpPaise: 12_000 })
    .returning();
  const people = await h.db
    .insert(users)
    .values([
      { name: 'Priya Sharma', phone: '+919800000001' },
      { name: 'Ravi Kumar', phone: '+919800000002' },
      { name: 'Asha Singh', phone: '+919800000003' },
    ])
    .returning();
  for (const u of people) {
    ids.push(u.id);
    tokens.push(await signAccessToken(u.id, 'customer'));
  }
  await deliveredOrder(ids[0], 'ED-1');
  await deliveredOrder(ids[1], 'ED-2');
  await deliveredOrder(ids[2], 'ED-3');
  expect((await call('POST', '/v1/orders/ED-1/ratings', { ratings: [{ productId: bulb, rating: 5, comment: 'Bright and cheap' }] }, tokens[0])).status).toBe(200);
  expect((await call('POST', '/v1/orders/ED-2/ratings', { ratings: [{ productId: bulb, rating: 1, comment: 'Stopped working in a week' }] }, tokens[1])).status).toBe(200);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('bad-word filter', () => {
  it('catches abuse, disguised abuse and Hindi abuse, but not normal words that contain them', () => {
    for (const bad of ['This is shit', 'total B!TCH product', 'f@ck this', 'sh1t quality', 'chutiya seller', 'Madarchod']) expect(hasBlockedWords(bad), bad).toBe(true);
    for (const ok of ['Stopcock fits well', 'Scunthorpe delivery', 'Assembled in 5 minutes', 'Dickson switch works', 'Class 1 wire']) expect(hasBlockedWords(ok), ok).toBe(false);
  });

  it('refuses a review with abusive words', async () => {
    const r = await call('POST', '/v1/orders/ED-3/ratings', { ratings: [{ productId: bulb, rating: 1, comment: 'Worst shit ever' }] }, tokens[2]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('comment_not_allowed');
  });
});

describe('report and block', () => {
  it('marks your own review and shows Report targets to others', async () => {
    const mine = await product(tokens[0]);
    expect(mine.recent.map((r: any) => [r.name, r.byYou])).toEqual([
      ['Ravi K.', false],
      ['Priya S.', true],
    ]);
    expect(mine.recent.every((r: any) => typeof r.id === 'number')).toBe(true);
    expect((await product()).recent.every((r: any) => r.byYou === false)).toBe(true);
  });

  it('needs a login, and you cannot report or block yourself', async () => {
    const ravi = (await product()).recent.find((r: any) => r.name === 'Ravi K.');
    expect((await call('POST', `/v1/reviews/${ravi.id}/report`, { reason: 'offensive' })).status).toBe(401);
    expect((await call('POST', `/v1/reviews/${ravi.id}/report`, { reason: 'offensive' }, tokens[1])).body.error.code).toBe('own_review');
    expect((await call('POST', `/v1/reviews/${ravi.id}/block-author`, undefined, tokens[1])).body.error.code).toBe('own_review');
    expect((await call('POST', `/v1/reviews/${ravi.id}/report`, { reason: 'rude' }, tokens[0])).status).toBe(400);
  });

  it('block hides that person’s reviews only for the customer who blocked them', async () => {
    const ravi = (await product()).recent.find((r: any) => r.name === 'Ravi K.');
    expect((await call('POST', `/v1/reviews/${ravi.id}/block-author`, undefined, tokens[2])).status).toBe(200);
    expect((await call('POST', `/v1/reviews/${ravi.id}/block-author`, undefined, tokens[2])).status).toBe(200); // twice is fine
    expect((await product(tokens[2])).recent.map((r: any) => r.name)).toEqual(['Priya S.']);
    expect((await product(tokens[0])).recent.map((r: any) => r.name)).toEqual(['Ravi K.', 'Priya S.']);
    // the stars still count everyone
    expect((await product(tokens[2])).count).toBe(2);
  });

  it('report hides the review from everyone at once and lists it for staff, who can restore or remove it', async () => {
    const ravi = (await product()).recent.find((r: any) => r.name === 'Ravi K.');
    expect((await call('POST', `/v1/reviews/${ravi.id}/report`, { reason: 'offensive' }, tokens[0])).status).toBe(200);
    expect((await call('POST', `/v1/reviews/${ravi.id}/report`, { reason: 'spam' }, tokens[0])).status).toBe(200); // one report per customer
    let shown = await product();
    expect(shown.recent.map((r: any) => r.name)).toEqual(['Priya S.']);
    expect([shown.count, shown.average]).toEqual([1, 5]);
    const [card] = await h.db.select({ n: products.ratingCount }).from(products);
    expect(card.n).toBe(1);

    expect((await call('GET', '/v1/integration/review-reports')).status).toBe(401);
    const list = await call('GET', '/v1/integration/review-reports', undefined, undefined, KEY);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: ravi.id, rating: 1, product_name: 'LED Bulb', author_name: 'Ravi Kumar', reports: 1, reasons: ['offensive'] });

    expect((await call('POST', `/v1/integration/reviews/${ravi.id}/restore`, undefined, undefined, KEY)).status).toBe(200);
    shown = await product();
    expect(shown.recent.map((r: any) => r.name)).toEqual(['Ravi K.', 'Priya S.']);
    expect(await h.db.$count(reviewReports)).toBe(0);
    expect((await call('GET', '/v1/integration/review-reports', undefined, undefined, KEY)).body.data).toHaveLength(0);

    await call('POST', `/v1/reviews/${ravi.id}/report`, { reason: 'offensive' }, tokens[0]);
    expect((await call('DELETE', `/v1/integration/reviews/${ravi.id}`, undefined, undefined, KEY)).status).toBe(200);
    expect(await h.db.$count(productReviews)).toBe(1);
    expect((await product()).count).toBe(1);
    expect((await call('POST', `/v1/reviews/${ravi.id}/report`, { reason: 'spam' }, tokens[0])).status).toBe(404);
  });

  it('deleting an account removes their reports and blocks', async () => {
    await h.db.insert(userBlocks).values({ userId: ids[0], blockedUserId: ids[2] });
    expect((await call('DELETE', '/v1/me', undefined, tokens[2])).status).toBe(200);
    expect(await h.db.$count(userBlocks)).toBe(0);
  });
});
