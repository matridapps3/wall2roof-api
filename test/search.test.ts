import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, productCategories, products } from '../src/db/schema.js';
import { searchStems } from '../src/routes/catalog.js';

let h: DbHandle;
let app: FastifyInstance;

async function search(query: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/products?${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
}
const skus = (body: any) => body.items.map((p: any) => p.sku).sort();

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [hanging, wall, switches] = await h.db
    .insert(categories)
    .values([
      { slug: 'hanging-lights', name: 'Hanging Lights' },
      { slug: 'wall-lights', name: 'Wall lights' },
      { slug: 'switches-sockets', name: 'Switches & Sockets' },
    ])
    .returning();
  const [philips] = await h.db.insert(brands).values({ slug: 'philips', name: 'Philips' }).returning();
  const base = { images: [] as string[], stockQty: 5, pricePaise: 10_000, mrpPaise: 12_000, brandId: philips.id };
  const rows = await h.db
    .insert(products)
    .values([
      { ...base, sku: 'P1', slug: 'p1', name: 'Lustre Pendant Light', categoryId: hanging.id },
      { ...base, sku: 'P2', slug: 'p2', name: 'Dewdrop Pendant Light', categoryId: hanging.id },
      { ...base, sku: 'W1', slug: 'w1', name: 'Sparkle Wall Light', categoryId: wall.id },
      { ...base, sku: 'S1', slug: 's1', name: '6A Twin Socket', categoryId: switches.id },
    ])
    .returning();
  // W1 is also listed under Hanging Lights
  await h.db.insert(productCategories).values({ productId: rows[2].id, categoryId: hanging.id });
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('search', () => {
  it('cuts words to simple stems so plurals match', () => {
    expect(searchStems('Hanging LIGHTS')).toEqual(['hanging', 'light']);
    expect(searchStems('switches bulbs glass')).toEqual(['switch', 'bulb', 'glass']);
  });

  it('finds products by their category name, including extra categories', async () => {
    // none of these names say "hanging", but they're in (or also listed under) Hanging Lights
    expect(skus(await search('q=hanging%20lights'))).toEqual(['P1', 'P2', 'W1']);
    expect(skus(await search('q=switches'))).toEqual(['S1']);
    // a singular word still finds plural category names and vice versa
    expect(skus(await search('q=sockets'))).toEqual(['S1']);
  });

  it('lists the categories of what was found, for the tiles above the results', async () => {
    const r = await search('q=light');
    expect(skus(r)).toEqual(['P1', 'P2', 'W1']);
    expect(r.facets.categories.map((c: any) => [c.slug, c.count])).toEqual([
      ['hanging-lights', 2],
      ['wall-lights', 1],
    ]);
    // narrowing to one of them works, and the tiles aren't repeated then
    const narrowed = await search('q=light&category=wall-lights');
    expect(skus(narrowed)).toEqual(['W1']);
    expect(narrowed.facets.categories).toEqual([]);
    // a search that only finds one category has no tiles
    expect((await search('q=socket')).facets.categories).toEqual([]);
  });

  it('suggests categories matching every word', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/search/suggest?q=hanging%20light' });
    // the name match first, then W1's main category (W1 is also listed under Hanging Lights)
    expect(res.json().categories.map((c: any) => c.slug)).toEqual(['hanging-lights', 'wall-lights']);
  });
});
