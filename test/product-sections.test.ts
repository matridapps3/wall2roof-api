import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';

import { buildApp } from '../src/app.js';
import { openDb, type DbHandle } from '../src/db/client.js';
import { brands, categories, orderItems, orders, products, users } from '../src/db/schema.js';

let h: DbHandle;
let app: FastifyInstance;

async function detail(slug: string) {
  const res = await app.inject({ method: 'GET', url: `/v1/products/${slug}` });
  expect(res.statusCode).toBe(200);
  return res.json() as any;
}
const skus = (list: any[]) => list.map((p) => p.sku);

beforeAll(async () => {
  h = await openDb({ memory: true });
  app = await buildApp(h.db);
  const [wires, lamps, switches] = await h.db
    .insert(categories)
    .values([
      { slug: 'wires', name: 'Wires' },
      { slug: 'lamps', name: 'Lamps' },
      { slug: 'switches', name: 'Switches & Sockets' },
    ])
    .returning();
  const [finolex, havells, philips] = await h.db
    .insert(brands)
    .values([
      { slug: 'finolex', name: 'Finolex' },
      { slug: 'havells', name: 'Havells' },
      { slug: 'philips', name: 'Philips' },
    ])
    .returning();
  const base = { images: [] as string[], stockQty: 5, mrpPaise: 100_000 };
  // W0 is the product we open; W1..W11 sit in its category at various prices
  const wireRows = Array.from({ length: 12 }, (_, i) => ({
    ...base,
    sku: `W${i}`,
    slug: `w${i}`,
    name: `Wire ${i}`,
    categoryId: wires.id,
    brandId: i % 3 === 0 ? finolex.id : havells.id,
    pricePaise: 10_000 + i * 1_000,
    isBestseller: i === 11,
  }));
  const inserted = await h.db
    .insert(products)
    .values([
      ...wireRows,
      { ...base, sku: 'L1', slug: 'l1', name: 'Lamp 1', categoryId: lamps.id, brandId: philips.id, pricePaise: 50_000, isBestseller: true },
      { ...base, sku: 'L2', slug: 'l2', name: 'Lamp 2', categoryId: lamps.id, brandId: philips.id, pricePaise: 60_000 },
      { ...base, sku: 'S1', slug: 's1', name: 'Modular Switch', categoryId: switches.id, brandId: havells.id, pricePaise: 9_000 },
    ])
    .returning();
  const bySku = new Map(inserted.map((p) => [p.sku, p]));

  // one past order bought W0 together with L2
  const [u] = await h.db.insert(users).values({ phone: '+919800000001' }).returning();
  const [o] = await h.db
    .insert(orders)
    .values({
      number: 'ED-TEST-1',
      userId: u.id,
      address: { label: 'home', name: 'A', phone: '+919800000001', line1: '1', city: 'Mohali', state: 'Punjab', pincode: '140306' } as any,
      subtotalPaise: 70_000,
      mrpTotalPaise: 200_000,
      deliveryFeePaise: 0,
      handlingFeePaise: 0,
      totalPaise: 70_000,
      paymentMethod: 'cod',
      idempotencyKey: 'k1',
    })
    .returning();
  await h.db.insert(orderItems).values(
    ['W0', 'L2'].map((sku) => ({
      orderId: o.id,
      productId: bySku.get(sku)!.id,
      sku,
      name: sku,
      qty: 1,
      unitPricePaise: bySku.get(sku)!.pricePaise,
      unitMrpPaise: 100_000,
    })),
  );
});

afterAll(async () => {
  await app.close();
  await h.close();
});

describe('product page sections', () => {
  it('picks 6 Similar and up to 6 Top products from the category, freshly each visit', async () => {
    const category = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11'];
    const picks = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const d = await detail('w0');
      const similar = skus(d.related);
      const top = skus(d.topInCategory);
      // two rows of three, like Blinkit; the 11 others split 6 + 5, never repeating or showing W0 itself
      expect(similar).toHaveLength(6);
      expect(top).toHaveLength(5);
      expect([...similar, ...top].sort()).toEqual([...category].sort());
      // Top is shown most popular first: the bestseller leads whenever it's in there
      if (top.includes('W11')) expect(top[0]).toBe('W11');
      picks.add(similar.join(','));
    }
    // a different pick on (almost) every visit
    expect(picks.size).toBeGreaterThan(1);
  });

  it('lists the brands in the category, most products first, with their logos', async () => {
    let d = await detail('w0');
    expect(d.brandsInCategory.map((b: any) => [b.slug, b.count])).toEqual([
      ['havells', 8],
      ['finolex', 4],
    ]);

    // a logo set from Wall2Roof (brands.logo_url) shows on the product and in the brands row
    await h.db.update(brands).set({ logoUrl: 'https://example.com/finolex.png' }).where(eq(brands.slug, 'finolex'));
    d = await detail('w0');
    expect(d.brandLogoUrl).toBe('https://example.com/finolex.png');
    expect(d.brandsInCategory.find((b: any) => b.slug === 'finolex').logoUrl).toBe('https://example.com/finolex.png');
    expect(d.brandsInCategory.find((b: any) => b.slug === 'havells').logoUrl).toBeNull();
  });

  it('puts products bought together first in "People also bought", then related shelves, then other categories', async () => {
    const d = await detail('w0');
    expect(skus(d.alsoBought)).toEqual(['L2', 'S1', 'L1']);
    // a wire nobody bought with anything: switches first (electrical, like wires), then the rest —
    // never its own category or itself
    const other = await detail('w5');
    expect(skus(other.alsoBought)).toEqual(['S1', 'L1', 'L2']);
    // a lamp: there's no other lighting shelf, so the top-up comes from anywhere but lamps
    const lamp = skus((await detail('l1')).alsoBought);
    expect(lamp).toHaveLength(6);
    expect(lamp.some((s) => s.startsWith('L'))).toBe(false);
  });
});
