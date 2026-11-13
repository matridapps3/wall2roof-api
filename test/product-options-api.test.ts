import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, products } from '../src/db/schema.js';
import { appOptions, sameSpelling } from '../src/lib/product-groups.js';

const KEY = 'test-integration-key-0123456789-abcdefghij';
let h: DbHandle;
let app: FastifyInstance;

async function detail(slug: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/products/${slug}` });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
}

async function call(method: 'GET' | 'PUT' | 'DELETE', url: string, body?: object) {
  const res = await app.inject({ method, url, payload: body, headers: { authorization: `Bearer ${KEY}` } });
  return { status: res.statusCode, body: res.json() as any };
}

/** What Wall2Roof sends for its Group_Classio SKU group. */
const classio = {
  name: 'Group_Classio',
  brand: 'V-Guard',
  options: [
    { key: 'mm', name: 'MM' },
    { key: 'cable_length', name: 'Cable Length' },
    { key: 'colour', name: 'Colour' },
  ],
  items: [
    { sku: 'C1R', values: { mm: '1 mm²', cable_length: '90 meter', colour: 'Red' } },
    { sku: 'C25Y', values: { mm: '2.5 mm²', cable_length: '90 meter', colour: 'Yellow' } },
    { sku: 'c1y', values: { mm: '1 mm²', cable_length: '90 meter', colour: 'Yellow' } },
    { sku: 'C4R', values: { mm: '4 mm²', cable_length: '90 meter', colour: 'Red' } },
    { sku: 'NOT-YET', values: { mm: '6 mm²', cable_length: '90 meter', colour: 'Red' } },
  ],
  updated_at: '2026-07-30 11:00:00',
};

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db, {}, { integrationKey: KEY });
  const [wires] = await h.db.insert(categories).values([{ slug: 'wires', name: 'Wires' }]).returning();
  const [vguard] = await h.db.insert(brands).values([{ slug: 'v-guard', name: 'V-Guard' }]).returning();
  const row = (sku: string, slug: string, name: string, extra: Partial<typeof products.$inferInsert> = {}) => ({
    sku,
    slug,
    name,
    brandId: vguard.id,
    categoryId: wires.id,
    specs: [],
    images: [],
    pricePaise: 200_000,
    mrpPaise: 300_000,
    stockQty: 5,
    ...extra,
  });
  await h.db.insert(products).values([
    row('C1R', 'classio-1-red', 'V-GUARD CLASSIO PLUS 90 MTRS 1 mm²-Red'),
    // names written differently still group: Wall2Roof decides, not the name
    row('C25Y', 'classio-2-5-yellow', 'VGUARD CLASSIO+ CABLE 2.5SQMM YELLOW (90M)', { pricePaise: 520_000 }),
    row('C1Y', 'classio-1-yellow', 'V-GUARD CLASSIO PLUS 90 MTRS 1 mm²-Yellow', { stockQty: 0 }),
    row('C4R', 'classio-4-red', 'V-GUARD CLASSIO PLUS 90 MTRS 4 mm²-Red', { isActive: false }),
    // same brand, category and name pattern, but not in the published group
    row('C10R', 'classio-10-red', 'V-GUARD CLASSIO PLUS 90 MTRS 10 mm²-Red'),
  ]);
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('publishing a Wall2Roof SKU group', () => {
  it('shows no options before the group is published', async () => {
    expect((await detail('classio-1-red')).options).toBeNull();
  });

  it('publishes and reports which SKUs the app will show', async () => {
    const r = await call('PUT', '/v1/integration/groups/42', classio);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      id: 42,
      created: true,
      skus: 5,
      live: 3,
      missing: ['NOT-YET'],
      inactive: ['C4R'],
      shown: true,
      moved_from: [],
    });
  });

  it("shows the group's options on each live product's page", async () => {
    const p = await detail('classio-1-red');
    expect(p.options.attributes.map((a: any) => [a.key, a.name, a.kind, a.values])).toEqual([
      ['size', 'Size', 'chips', ['1 mm²', '2.5 mm²']],
      ['length', 'Length', 'chips', ['90 meter']],
      ['colour', 'Colour', 'colour', ['Red', 'Yellow']],
    ]);
    expect(p.options.items.map((i: any) => [i.slug, i.selected, i.inStock]).sort()).toEqual([
      ['classio-1-red', true, true],
      ['classio-1-yellow', false, false],
      ['classio-2-5-yellow', false, true],
    ]);
    expect((await detail('classio-2-5-yellow')).options.items.find((i: any) => i.selected).slug).toBe('classio-2-5-yellow');
  });

  it('leaves products outside the group alone, and keeps group members out of Similar products', async () => {
    expect((await detail('classio-10-red')).options).toBeNull();
    const related = (await detail('classio-1-red')).related.map((c: any) => c.slug);
    expect(related).toEqual(['classio-10-red']);
  });

  it('lists published groups for the SKU Group screen', async () => {
    const r = await call('GET', '/v1/integration/groups');
    expect(r.body.data).toEqual([
      expect.objectContaining({ id: 42, name: 'Group_Classio', brand: 'V-Guard', skus: 5, live: 3, source_updated_at: '2026-07-30 11:00:00' }),
    ]);
  });

  it('moves a SKU published again in another group', async () => {
    const r = await call('PUT', '/v1/integration/groups/43', {
      name: 'Group_two',
      options: [{ key: 'colour', name: 'Colour' }],
      items: [
        { sku: 'C1R', values: { colour: 'Red' } },
        { sku: 'C10R', values: { colour: 'Blue' } },
      ],
    });
    expect(r.body).toMatchObject({ created: true, live: 2, shown: true, moved_from: ['Group_Classio'] });
    expect((await detail('classio-1-red')).options.attributes).toEqual([{ key: 'colour', name: 'Colour', kind: 'colour', values: ['Blue', 'Red'] }]);
    // Group_Classio keeps C25Y and C1Y: Size 1 / 2.5 there now
    expect((await detail('classio-1-yellow')).options.attributes[0].values).toEqual(['1 mm²', '2.5 mm²']);
  });

  it('unpublishes: the products show no options', async () => {
    expect((await call('DELETE', '/v1/integration/groups/43')).body).toEqual({ ok: true, deleted: true });
    expect((await call('DELETE', '/v1/integration/groups/43')).body).toEqual({ ok: true, deleted: false });
    expect((await detail('classio-1-red')).options).toBeNull();
  });

  it('refuses a group without options or SKUs', async () => {
    expect((await call('PUT', '/v1/integration/groups/44', { name: 'x', options: [], items: [{ sku: 'C1R' }] })).status).toBe(422);
    expect((await call('PUT', '/v1/integration/groups/44', { name: 'x', options: [{ key: 'mm' }], items: [] })).status).toBe(422);
  });
});

describe('sameSpelling', () => {
  it('makes values that differ only in capitals or spaces one choice, spelled as most products spell it', () => {
    // Philips Full Glow: three say "Natural white", one "Natural White"; "CDL" is a different word and stays
    const members = ['Natural white', 'Natural White', 'Natural white', 'Natural  white', 'CDL', 'Cool Day light'].map((light, i) => ({
      values: { light, wattage: i % 2 ? '12W' : '12w' },
    }));
    sameSpelling(members, [{ key: 'light' }, { key: 'wattage' }]);
    expect(members.map((m) => m.values.light)).toEqual(['Natural white', 'Natural white', 'Natural white', 'Natural white', 'CDL', 'Cool Day light']);
    // a tie (3 and 3) goes to the one with more capitals
    expect(new Set(members.map((m) => m.values.wattage))).toEqual(new Set(['12W']));
  });
});

describe('appOptions', () => {
  it("maps Wall2Roof keys the app knows and keeps the others' own names", () => {
    expect(
      appOptions([
        { key: 'conductor_nominal_area', name: 'Conductor Nominal Area' },
        { key: 'body_color', name: 'Body Color' },
        { key: 'colour', name: 'Colour' },
        { key: 'light_color', name: 'Light Color' },
        { key: 'number_of_pairs', name: 'Number of Pairs' },
      ]).map((o) => [o.source, o.key, o.name, o.kind]),
    ).toEqual([
      ['conductor_nominal_area', 'size', 'Size', 'chips'],
      ['body_color', 'colour', 'Colour', 'colour'],
      ['colour', 'colour_2', 'Colour', 'chips'],
      ['light_color', 'light', 'Light colour', 'chips'],
      ['number_of_pairs', 'number_of_pairs', 'Number of Pairs', 'chips'],
    ]);
  });
});
