import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { cartItems, coupons, products } from '../db/schema.js';
import { HttpError, parse, requireUser } from '../http.js';
import { categoriesOf } from '../lib/categories.js';
import { isFirstOrder, normalizeLines, priceCart } from '../lib/checkout.js';
import { evaluateCoupon, MAX_TIP_PAISE } from '../lib/pricing.js';

const line = z.object({ productId: z.number().int().positive(), qty: z.number().int().min(0).max(99) });
const quoteBody = z.object({
  items: z.array(line).max(100),
  couponCode: z.string().trim().max(40).nullish(),
  paymentMethod: z.enum(['cod', 'online']).nullish(),
  /** "Tip your delivery partner", up to ₹500 */
  tipPaise: z.number().int().min(0).max(MAX_TIP_PAISE).default(0),
});

async function serverCart(db: Db, userId: number) {
  return db.select().from(cartItems).where(eq(cartItems.userId, userId)).orderBy(asc(cartItems.updatedAt));
}

async function cartResponse(db: Db, userId: number, couponCode?: string | null, paymentMethod?: 'cod' | 'online' | null) {
  const rows = await serverCart(db, userId);
  return priceCart(db, { userId, lines: rows.map((r) => ({ productId: r.productId, qty: r.qty })), couponCode, paymentMethod });
}

export async function cartRoutes(app: FastifyInstance, { db }: { db: Db }) {
  /** Stateless pricing — works for guests (their cart lives on the device). */
  app.post('/v1/cart/quote', async (req) => {
    const body = parse(quoteBody, req.body);
    const userId = req.auth ? Number(req.auth.sub) : null;
    return priceCart(db, { userId, lines: body.items, couponCode: body.couponCode, paymentMethod: body.paymentMethod, tipPaise: body.tipPaise });
  });

  app.get('/v1/cart', async (req) => {
    const userId = requireUser(req);
    const q = parse(
      z.object({ couponCode: z.string().max(40).optional(), paymentMethod: z.enum(['cod', 'online']).optional() }),
      req.query,
    );
    return cartResponse(db, userId, q.couponCode, q.paymentMethod);
  });

  /** Set the quantity of one product (0 removes it). */
  app.put('/v1/cart/items', async (req) => {
    const userId = requireUser(req);
    const body = parse(line, req.body);
    if (body.qty === 0) {
      await db.delete(cartItems).where(and(eq(cartItems.userId, userId), eq(cartItems.productId, body.productId)));
    } else {
      const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, body.productId));
      if (!p) throw new HttpError(404, 'not_found', 'This product is no longer available.');
      await db
        .insert(cartItems)
        .values({ userId, productId: body.productId, qty: body.qty })
        .onConflictDoUpdate({ target: [cartItems.userId, cartItems.productId], set: { qty: body.qty, updatedAt: new Date() } });
    }
    return cartResponse(db, userId);
  });

  /** After login: add the device's guest cart to the account cart (keeps the larger quantity). */
  app.post('/v1/cart/merge', async (req) => {
    const userId = requireUser(req);
    const { items } = parse(z.object({ items: z.array(line).max(100) }), req.body);
    const existing = new Map((await serverCart(db, userId)).map((r) => [r.productId, r.qty]));
    for (const l of normalizeLines(items)) {
      const qty = Math.max(l.qty, existing.get(l.productId) ?? 0);
      const [p] = await db.select({ id: products.id }).from(products).where(eq(products.id, l.productId));
      if (!p) continue;
      await db
        .insert(cartItems)
        .values({ userId, productId: l.productId, qty })
        .onConflictDoUpdate({ target: [cartItems.userId, cartItems.productId], set: { qty, updatedAt: new Date() } });
    }
    return cartResponse(db, userId);
  });

  /** Replace the whole account cart (the app sends its cart right before checkout). */
  app.put('/v1/cart', async (req) => {
    const userId = requireUser(req);
    const { items } = parse(z.object({ items: z.array(line).max(100) }), req.body);
    const lines = normalizeLines(items);
    const known = lines.length
      ? new Set(
          (await db.select({ id: products.id }).from(products).where(inArray(products.id, lines.map((l) => l.productId)))).map(
            (r) => r.id,
          ),
        )
      : new Set<number>();
    await db.transaction(async (tx) => {
      await tx.delete(cartItems).where(eq(cartItems.userId, userId));
      const rows = lines.filter((l) => known.has(l.productId)).map((l) => ({ userId, productId: l.productId, qty: l.qty }));
      if (rows.length) await tx.insert(cartItems).values(rows);
    });
    return cartResponse(db, userId);
  });

  app.delete('/v1/cart', async (req) => {
    const userId = requireUser(req);
    await db.delete(cartItems).where(eq(cartItems.userId, userId));
    return { ok: true };
  });

  /** Active coupons, each evaluated against the given cart ("Add ₹62 more to unlock"). */
  app.post('/v1/coupons', async (req) => {
    const { items } = parse(z.object({ items: z.array(line).max(100).default([]) }), req.body ?? {});
    const userId = req.auth ? Number(req.auth.sub) : null;
    const now = new Date();
    const lines = normalizeLines(items);
    const [list, rows, first] = await Promise.all([
      db
        .select()
        .from(coupons)
        .where(and(eq(coupons.isActive, true), or(isNull(coupons.validUntil), gt(coupons.validUntil, now))))
        .orderBy(asc(coupons.minOrderPaise)),
      lines.length ? db.select().from(products).where(inArray(products.id, lines.map((l) => l.productId))) : [],
      isFirstOrder(db, userId),
    ]);
    const byId = new Map(rows.map((p) => [p.id, p]));
    const cats = await categoriesOf(db, rows);
    const cart = lines.flatMap((l) => {
      const p = byId.get(l.productId);
      return p && p.isActive && p.stockQty > 0 ? [{ product: { ...p, categoryIds: cats.get(p.id) ?? [] }, qty: l.qty }] : [];
    });
    return {
      coupons: list.map((c) => {
        const result = evaluateCoupon(c, cart, { isFirstOrder: first, now });
        return {
          code: c.code,
          title: c.title,
          description: c.description,
          type: c.type,
          value: c.value,
          maxDiscountPaise: c.maxDiscountPaise,
          minOrderPaise: c.minOrderPaise,
          validUntil: c.validUntil?.toISOString() ?? null,
          eligible: result.applied,
          savingPaise: result.applied ? result.discountPaise : null,
          reason: result.applied ? null : result.reason,
        };
      }),
    };
  });
}
