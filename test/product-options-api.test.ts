import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, products } from '../src/db/schema.js';

let h: DbHandle;
let app: FastifyInstance;

async function detail(slug: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/products/${slug}` });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
}

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [wires, lights] = await h.db.insert(categories).values([{ slug: 'wires', name: 'Wires' }, { slug: 'lights', name: 'Lights' }]).returning();
  const [vguard, havells] = await h.db.insert(brands).values([{ slug: 'v-guard', name: 'V-Guard' }, { slug: 'havells', name: 'Havells' }]).returning();
  const specs = (mm: string, colour: string) => [
    { label: 'MM', value: mm },
    { label: 'Colour', value: colour },
    { label: 'Length', value: '90 meter' },
  ];
  const row = (sku: string, slug: string, mm: string, colour: string, extra: Partial<typeof products.$inferInsert> = {}) => ({
    sku,
    slug,
    name: `V-GUARD CLASSIO PLUS WIRING CABLE 90 MTRS ${mm}-${colour}`,
    brandId: vguard.id,
    categoryId: wires.id,
    specs: specs(mm, colour),
    images: [],
    pricePaise: 200_000,
    mrpPaise: 300_000,
    stockQty: 5,
    ...extra,
  });
  await h.db.insert(products).values([
    row('C1R', 'classio-1-red', '1 mm²', 'Red'),
    row('C25Y', 'classio-2-5-yellow', '2.5 mm²', 'Yellow', { pricePaise: 520_000 }),
    row('C1Y', 'classio-1-yellow', '1 mm²', 'Yellow', { stockQty: 0 }),
    // not shown: switched off, another brand, another category
    row('C4R', 'classio-4-red', '4 mm²', 'Red', { isActive: false }),
    row('H1R', 'havells-1-red', '1 mm²', 'Red', { brandId: havells.id }),
    row('C6R', 'classio-6-red', '6 mm²', 'Red', { categoryId: lights.id }),
    { sku: 'LONE', slug: 'lone-wire', name: 'V-GUARD FRLSH HOUSE WIRING CABLE 4SQ.MM', brandId: vguard.id, categoryId: wires.id, specs: specs('4 mm²', 'Yellow'), images: [], pricePaise: 1, mrpPaise: 1, stockQty: 1 },
  ]);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('GET /v1/products/:slug options', () => {
  it('lists the sibling sizes and colours of the same brand and category', async () => {
    const p = await detail('classio-1-red');
    expect(p.options.attributes.map((a: any) => [a.key, a.values])).toEqual([
      ['size', ['1 mm²', '2.5 mm²']],
      ['colour', ['Red', 'Yellow']],
      ['length', ['90 meter']],
    ]);
    expect(p.options.items.map((i: any) => [i.slug, i.selected, i.inStock])).toEqual([
      ['classio-1-red', true, true],
      ['classio-2-5-yellow', false, true],
      ['classio-1-yellow', false, false],
    ]);
    expect(p.variants).toEqual([]); // the old pack-size list is untouched, so older apps show nothing new
  });

  it('marks the opened sibling as selected', async () => {
    const p = await detail('classio-2-5-yellow');
    expect(p.options.items.find((i: any) => i.selected).slug).toBe('classio-2-5-yellow');
  });

  it('has no options for a product without siblings', async () => {
    expect((await detail('lone-wire')).options).toBeNull();
  });
});
