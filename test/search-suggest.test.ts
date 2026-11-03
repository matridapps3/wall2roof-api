import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, productCategories, products } from '../src/db/schema.js';
import { rankSuggestCategories } from '../src/routes/catalog.js';

let h: DbHandle;
let app: FastifyInstance;

async function suggest(q: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/search/suggest?q=${encodeURIComponent(q)}` });
  expect(res.statusCode).toBe(200);
  return res.json() as { products: any[]; categories: any[] };
}
const slugs = (body: { categories: any[] }) => body.categories.map((c) => c.slug);

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [ceiling, wall, outdoor, strip, , hidden, switches] = await h.db
    .insert(categories)
    .values([
      { slug: 'ceiling-lights', name: 'Ceiling Lights', imageUrl: 'https://cdn.example.com/ceiling.png', sort: 1 },
      { slug: 'wall-lights', name: 'Wall lights', sort: 2 },
      { slug: 'outdoor-lights', name: 'Outdoor lights', sort: 3 },
      { slug: 'strip-lights', name: 'Strip Lights', sort: 4 },
      { slug: 'empty-lights', name: 'Empty Lights' },
      { slug: 'hidden-lights', name: 'Hidden Lights', isActive: false },
      { slug: 'switches-sockets', name: 'Switches & Sockets' },
    ])
    .returning();
  const [philips] = await h.db.insert(brands).values({ slug: 'philips', name: 'Philips' }).returning();
  const base = { images: [] as string[], stockQty: 5, pricePaise: 10_000, mrpPaise: 12_000, brandId: philips.id };
  const rows = await h.db
    .insert(products)
    .values([
      { ...base, sku: 'SURF', slug: 'surf', name: 'Striker Surface Lamp', categoryId: ceiling.id },
      { ...base, sku: 'W1', slug: 'w1', name: 'Sparkle Wall Lamp', categoryId: wall.id },
      { ...base, sku: 'O1', slug: 'o1', name: 'Garden Spike Lamp', categoryId: outdoor.id },
      { ...base, sku: 'O2', slug: 'o2', name: 'Gate Pillar Lamp', categoryId: outdoor.id },
      { ...base, sku: 'O3', slug: 'o3', name: 'Outdoor Wall Lamp', categoryId: outdoor.id },
      { ...base, sku: 'ST1', slug: 'st1', name: 'LED Strip 5m', categoryId: strip.id },
      { ...base, sku: 'G1', slug: 'g1', name: 'Spike Guard Strip 4-way', categoryId: switches.id },
      { ...base, sku: 'G2', slug: 'g2', name: 'Spike Guard Strip 6-way', categoryId: switches.id },
      { ...base, sku: 'H1', slug: 'h1', name: 'Hidden Garden Light', categoryId: hidden.id },
      { ...base, sku: 'OFF', slug: 'off', name: 'Retired Surface Lamp', categoryId: wall.id, isActive: false },
    ])
    .returning();
  // O3 is also listed under Wall lights
  await h.db.insert(productCategories).values({ productId: rows[4].id, categoryId: wall.id });
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('search suggestions', () => {
  it('suggests the category of matching products even when no category name has the words', async () => {
    const r = await suggest('surface light');
    // the retired Surface Lamp (in Wall lights) doesn't count
    expect(r.products.map((p) => p.sku)).toEqual(['SURF']);
    expect(r.categories).toEqual([{ slug: 'ceiling-lights', name: 'Ceiling Lights', imageUrl: 'https://cdn.example.com/ceiling.png' }]);
  });

  it('ranks name matches by matching products, at most 3', async () => {
    // Outdoor 3, Wall 2 (O3 is listed there too), Ceiling and Strip 1 each (Ceiling sorts first)
    expect(slugs(await suggest('light'))).toEqual(['outdoor-lights', 'wall-lights', 'ceiling-lights']);
  });

  it('puts a name match before categories found only through products', async () => {
    // Switches & Sockets holds more "strip" products, but Strip Lights says "strip"
    expect(slugs(await suggest('strip'))).toEqual(['strip-lights', 'switches-sockets']);
    expect(slugs(await suggest('wall'))).toEqual(['wall-lights', 'outdoor-lights']);
  });

  it('never suggests an empty or a hidden category', async () => {
    expect(slugs(await suggest('empty'))).toEqual([]);
    const hidden = await suggest('hidden light');
    expect(hidden.products.map((p) => p.sku)).toEqual(['H1']);
    expect(hidden.categories).toEqual([]);
  });

  it('always answers with products and categories (older apps read both)', async () => {
    expect(await suggest('zzzz')).toEqual({ products: [], categories: [] });
  });

  it('ranks, removes repeats and caps the rows', () => {
    const c = (id: number, name: string, sort = 0) => ({ id, name, sort });
    const counts = new Map([
      [1, 1],
      [2, 4],
      [3, 2],
      [4, 2],
      [5, 9],
      [6, 2],
    ]);
    // named first (even with fewer products), ties by sort then name, empty ones dropped
    expect(rankSuggestCategories([c(1, 'One'), c(9, 'Empty')], [c(5, 'Five'), c(1, 'One')], counts).map((x) => x.id)).toEqual([1, 5]);
    expect(rankSuggestCategories([c(4, 'Bee', 1), c(3, 'Ant', 1), c(6, 'Cat', 0)], [], counts).map((x) => x.id)).toEqual([6, 3, 4]);
    expect(rankSuggestCategories([], [c(1, 'One'), c(2, 'Two'), c(3, 'Three'), c(5, 'Five')], counts).map((x) => x.id)).toEqual([5, 2, 3]);
    expect(rankSuggestCategories([c(2, 'Two')], [c(5, 'Five')], counts, 1).map((x) => x.id)).toEqual([2]);
  });
});
