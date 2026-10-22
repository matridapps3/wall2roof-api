import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, products } from '../src/db/schema.js';
import { parsePicked } from '../src/lib/filters.js';

let h: DbHandle;
let app: FastifyInstance;

async function list(query: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/products?category=lamps&${query}` });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
}

const skus = (body: any) => body.items.map((p: any) => p.sku).sort();
const group = (body: any, key: string) => body.facets.specs.find((g: any) => g.key === key);

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [cat] = await h.db.insert(categories).values({ slug: 'lamps', name: 'Lamps' }).returning();
  const [philips, wipro] = await h.db
    .insert(brands)
    .values([
      { slug: 'philips', name: 'Philips' },
      { slug: 'wipro', name: 'Wipro' },
    ])
    .returning();
  const base = { categoryId: cat.id, images: [] as string[], stockQty: 5 };
  await h.db.insert(products).values([
    {
      ...base,
      brandId: philips.id,
      sku: 'L1',
      slug: 'l1',
      name: 'Floor lamp',
      pricePaise: 300_000,
      mrpPaise: 350_000,
      specs: [
        { label: 'Country of Origin', value: 'India' },
        { label: 'Light Color', value: 'Warm White' },
      ],
    },
    {
      ...base,
      brandId: wipro.id,
      sku: 'L2',
      slug: 'l2',
      name: 'Chandelier',
      pricePaise: 2_500_000,
      mrpPaise: 2_500_000,
      specs: [
        { label: 'Country of Origin', value: 'China' },
        { label: 'Light Colour', value: 'warm white ' },
        { label: 'Wattage', value: '3 × 6W G9 LED bulbs (included)' },
      ],
    },
    {
      ...base,
      brandId: philips.id,
      sku: 'L3',
      slug: 'l3',
      name: 'Table lamp',
      pricePaise: 80_000,
      mrpPaise: 90_000,
      specs: [
        { label: 'country of origin', value: 'India' },
        { label: 'Light Color', value: 'Cool White' },
      ],
    },
  ]);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('product filters', () => {
  it('counts price ranges and product details, Blinkit-style', async () => {
    const all = await list('');
    expect(all.total).toBe(3);
    expect(all.facets.brands).toEqual([
      { slug: 'philips', name: 'Philips', logoUrl: null, count: 2 },
      { slug: 'wipro', name: 'Wipro', logoUrl: null, count: 1 },
    ]);
    // only ranges that have products
    expect(all.facets.prices).toEqual([
      { key: '500-999', label: '₹500 - ₹999', count: 1 },
      { key: '1k-5k', label: '₹1,000 - ₹4,999', count: 1 },
      { key: '20k+', label: '₹20,000 and above', count: 1 },
    ]);
    expect(group(all, 'origin').options).toEqual([
      { value: 'india', label: 'India', count: 2 },
      { value: 'china', label: 'China', count: 1 },
    ]);
    // "Light Color" / "Light Colour" and "Warm White" / "warm white " are the same option
    expect(group(all, 'light')).toMatchObject({
      name: 'Light colour',
      options: [
        { value: 'warm white', count: 2 },
        { value: 'cool white', count: 1 },
      ],
    });
    // a long bracketed value is no use as an option, so there's no Wattage group
    expect(group(all, 'wattage')).toBeUndefined();
  });

  it('narrows across groups and widens within one', async () => {
    const india = await list('spec=origin:India');
    expect(skus(india)).toEqual(['L1', 'L3']);
    // the ticked group still offers its other options
    expect(group(india, 'origin').options.map((o: any) => [o.value, o.count])).toEqual([
      ['india', 2],
      ['china', 1],
    ]);
    // other groups count within India only
    expect(group(india, 'light').options.map((o: any) => [o.value, o.count])).toEqual([
      ['cool white', 1],
      ['warm white', 1],
    ]);

    expect(skus(await list('spec=origin:India&spec=light:Warm%20White'))).toEqual(['L1']);
    expect(skus(await list('spec=origin:India&spec=origin:China'))).toEqual(['L1', 'L2', 'L3']);
    expect(skus(await list('price=20k%2B'))).toEqual(['L2']);
    expect(skus(await list('price=20k%2B&price=500-999'))).toEqual(['L2', 'L3']);
    expect(skus(await list('brand=philips&price=1k-5k'))).toEqual(['L1']);

    const none = await list('brand=wipro&spec=origin:India');
    expect(none).toMatchObject({ items: [], total: 0 });
    // the ticked brand is still offered, at 0, so it can be unticked
    expect(none.facets.brands).toEqual([
      { slug: 'philips', name: 'Philips', logoUrl: null, count: 2 },
      { slug: 'wipro', name: 'Wipro', logoUrl: null, count: 0 },
    ]);
  });

  it('ignores unknown groups and price keys', () => {
    expect(parsePicked({ spec: ['nope:x', 'origin:India', ':x'], price: 'cheap,u500', brand: 'a,b' })).toEqual({
      brands: ['a', 'b'],
      prices: ['u500'],
      specs: { origin: ['india'] },
    });
  });
});
