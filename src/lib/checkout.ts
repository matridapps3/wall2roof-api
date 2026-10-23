import { and, eq, inArray, ne, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { brands, coupons, orders, products } from '../db/schema.js';
import { productCard } from '../routes/catalog.js';
import { categoriesOf } from './categories.js';
import { quote, type PricingCoupon, type Quote } from './pricing.js';
import { getSettings } from './settings.js';

export type CartLineInput = { productId: number; qty: number };

/** Merge duplicate product lines and drop non-positive quantities. */
export function normalizeLines(lines: CartLineInput[]): CartLineInput[] {
  const m = new Map<number, number>();
  for (const l of lines) if (l.qty > 0) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qty);
  return [...m].map(([productId, qty]) => ({ productId, qty }));
}

export async function isFirstOrder(db: Db, userId: number | null): Promise<boolean> {
  if (userId == null) return true;
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.userId, userId), ne(orders.status, 'cancelled')));
  return n === 0;
}

export async function findCoupon(db: Db, code: string | null | undefined): Promise<PricingCoupon | null> {
  if (!code) return null;
  const [c] = await db.select().from(coupons).where(eq(coupons.code, code.trim().toUpperCase()));
  return c ?? null;
}

export type PricedCart = Quote & {
  products: Record<number, ReturnType<typeof productCard>>;
};

/**
 * Price a set of lines against current database prices and stock. Lines for
 * products that no longer exist are reported as unavailable.
 */
export async function priceCart(
  db: Db,
  opts: { userId: number | null; lines: CartLineInput[]; couponCode?: string | null; paymentMethod?: 'cod' | 'online' | null; tipPaise?: number },
): Promise<PricedCart> {
  const lines = normalizeLines(opts.lines);
  const ids = lines.map((l) => l.productId);
  const rows = ids.length
    ? await db
        .select({ p: products, brandName: brands.name })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .where(inArray(products.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.p.id, r]));
  const [settings, coupon, first, cats] = await Promise.all([
    getSettings(db),
    findCoupon(db, opts.couponCode),
    isFirstOrder(db, opts.userId),
    categoriesOf(db, rows.map((r) => r.p)),
  ]);

  const priced = lines.map((l) => {
    const row = byId.get(l.productId);
    const p = row?.p;
    return {
      qty: l.qty,
      product: p
        ? { ...p, categoryIds: cats.get(p.id) ?? [] }
        : // Deleted product: price 0, unavailable.
          { id: l.productId, name: 'Unavailable item', pricePaise: 0, mrpPaise: 0, stockQty: 0, maxPerOrder: 0, isActive: false, categoryId: null },
    };
  });

  const q = quote({
    lines: priced,
    fees: settings,
    coupon,
    unknownCouponCode: opts.couponCode && !coupon ? opts.couponCode.trim().toUpperCase() : null,
    paymentMethod: opts.paymentMethod ?? null,
    tipPaise: opts.tipPaise ?? 0,
    isFirstOrder: first,
  });

  const cards: PricedCart['products'] = {};
  for (const r of rows) cards[r.p.id] = productCard(r.p, r.brandName ? { name: r.brandName } : null);
  return { ...q, products: cards };
}
