import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import {
  addresses,
  brands,
  cartItems,
  notifications,
  orderEvents,
  orderItems,
  orders,
  productReviews,
  products,
  returnRequests,
  type AddressFields,
} from '../db/schema.js';
import { HttpError, parse, requireAdmin, requireUser } from '../http.js';
import { categoriesOf } from '../lib/categories.js';
import { findCoupon, isFirstOrder } from '../lib/checkout.js';
import { quote } from '../lib/pricing.js';
import { ratingsForOrders, refreshProductRatings, type OrderRatings } from '../lib/reviews.js';
import { getSettings, isServiceable } from '../lib/settings.js';
import { productCard } from './catalog.js';

type OrderRow = typeof orders.$inferSelect;
type Status = OrderRow['status'];

export const CANCELLABLE: Status[] = ['placed', 'confirmed'];

/** Allowed status moves for the admin / delivery side. */
export const NEXT_STATUS: Record<Status, Status[]> = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['packed', 'cancelled'],
  packed: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function orderNumber(id: number, at = new Date()): string {
  return `ED-${at.getFullYear()}-${String(10000 + id)}`;
}

/** The customer's average stars over this order's items they rated (null until they rate one). */
function orderRating(items: (typeof orderItems.$inferSelect)[], mine: OrderRatings) {
  const stars = items.flatMap((i) => (i.productId != null && mine.has(i.productId) ? [mine.get(i.productId)!.rating] : []));
  return stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10 : null;
}

function summary(o: OrderRow, items: (typeof orderItems.$inferSelect)[], deliveredAt: Date | null, mine: OrderRatings) {
  return {
    number: o.number,
    status: o.status,
    placedAt: o.createdAt.toISOString(),
    totalPaise: o.totalPaise,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    /** first few items, for the photo row on order cards (and searching them) */
    preview: items.slice(0, 6).map((i) => ({ name: i.name, image: i.image, qty: i.qty })),
    /** when it was delivered, for Blinkit's 'Arrived in 1 hr 20 mins' */
    deliveredAt: deliveredAt?.toISOString() ?? null,
    /** Blinkit's "Rate order": only delivered orders can be rated */
    canRate: o.status === 'delivered',
    /** the customer's average stars for this order's items (null until rated) */
    myRating: orderRating(items, mine),
  };
}

async function loadOrder(db: Db, userId: number, number: string) {
  const [o] = await db.select().from(orders).where(and(eq(orders.number, number), eq(orders.userId, userId)));
  // 404 for other people's orders too, so order numbers can't be probed.
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  return o;
}

async function detail(db: Db, o: OrderRow) {
  const [items, events, returns] = await Promise.all([
    db.select().from(orderItems).where(eq(orderItems.orderId, o.id)).orderBy(asc(orderItems.id)),
    db.select().from(orderEvents).where(eq(orderEvents.orderId, o.id)).orderBy(asc(orderEvents.createdAt)),
    db.select().from(returnRequests).where(eq(returnRequests.orderId, o.id)),
  ]);
  const deliveredAt = events.find((e) => e.status === 'delivered')?.createdAt ?? null;
  // the product's pack size ("2 ltr", "Pack of 2") for "2 ltr x 1" on the order page, and its page, which
  // tapping the item opens (null when the product is gone or hidden)
  const productIds = items.flatMap((i) => (i.productId == null ? [] : [i.productId]));
  // what the customer gave this order (rating the same product from another order doesn't count here)
  const mine: OrderRatings = (await ratingsForOrders(db, o.userId, [o.id])).get(o.id) ?? new Map();
  const found = productIds.length
    ? new Map(
        (await db.select({ id: products.id, label: products.variantLabel, slug: products.slug, isActive: products.isActive }).from(products).where(inArray(products.id, productIds))).map((p) => [p.id, p]),
      )
    : new Map<number, { label: string | null; slug: string; isActive: boolean }>();
  return {
    ...summary(o, items, deliveredAt, mine),
    address: o.address,
    deliveryInstructions: o.deliveryInstructions,
    items: items.map((i) => {
      const windowEnds = deliveredAt && i.returnable ? new Date(deliveredAt.getTime() + i.returnDays * 86_400_000) : null;
      return {
        id: i.id,
        productId: i.productId,
        sku: i.sku,
        name: i.name,
        image: i.image,
        unitLabel: (i.productId != null ? found.get(i.productId)?.label : null) ?? null,
        /** the product page to open from the order (null when the product is gone or hidden) */
        slug: (i.productId != null && found.get(i.productId)?.isActive ? found.get(i.productId)?.slug : null) ?? null,
        qty: i.qty,
        unitPricePaise: i.unitPricePaise,
        unitMrpPaise: i.unitMrpPaise,
        returnable: i.returnable,
        returnWindowEndsAt: windowEnds?.toISOString() ?? null,
        canReturn: !!windowEnds && windowEnds.getTime() > Date.now(),
        /** the customer's stars and words for this product (null until rated) */
        myRating: (i.productId != null ? mine.get(i.productId)?.rating : null) ?? null,
        myComment: (i.productId != null ? mine.get(i.productId)?.comment : null) ?? null,
      };
    }),
    bill: {
      mrpTotalPaise: o.mrpTotalPaise,
      subtotalPaise: o.subtotalPaise,
      deliveryFeePaise: o.deliveryFeePaise,
      handlingFeePaise: o.handlingFeePaise,
      codFeePaise: o.codFeePaise,
      discountPaise: o.discountPaise,
      couponCode: o.couponCode,
      totalPaise: o.totalPaise,
    },
    timeline: events.map((e) => ({ status: e.status, at: e.createdAt.toISOString(), note: e.note })),
    canCancel: CANCELLABLE.includes(o.status),
    cancelReason: o.cancelReason,
    returns: returns.map((r) => ({ id: r.id, status: r.status, resolution: r.resolution, reason: r.reason })),
  };
}

const STATUS_COPY: Record<Status, string> = {
  placed: 'Order placed',
  confirmed: 'Order confirmed',
  packed: 'Order packed',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Order cancelled',
};

export async function orderRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.post('/v1/orders', async (req, reply) => {
    const userId = requireUser(req);
    const body = parse(
      z.object({
        addressId: z.number().int().positive(),
        couponCode: z.string().trim().max(40).nullish(),
        paymentMethod: z.enum(['cod', 'online']),
        instructions: z.array(z.string().max(60)).max(5).default([]),
        idempotencyKey: z.string().min(8).max(80),
      }),
      req.body,
    );

    const [dupe] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, body.idempotencyKey)));
    if (dupe) return detail(db, dupe);

    const settings = await getSettings(db);
    if (body.paymentMethod === 'online' && !settings.onlinePaymentsEnabled) {
      throw new HttpError(400, 'payment_unavailable', 'Online payment isn’t available yet. Choose cash on delivery.');
    }
    if (body.paymentMethod === 'cod' && !settings.codEnabled) {
      throw new HttpError(400, 'payment_unavailable', 'Cash on delivery isn’t available right now.');
    }

    const [addr] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, body.addressId), eq(addresses.userId, userId)));
    if (!addr) throw new HttpError(400, 'invalid_address', 'Choose a delivery address.');
    if (!isServiceable(settings, addr.pincode)) {
      throw new HttpError(400, 'not_serviceable', `We don’t deliver to ${addr.pincode} yet.`);
    }

    const coupon = await findCoupon(db, body.couponCode);
    const first = await isFirstOrder(db, userId);

    const created = await db.transaction(async (tx) => {
      const cart = await tx.select().from(cartItems).where(eq(cartItems.userId, userId));
      if (!cart.length) throw new HttpError(400, 'empty_cart', 'Your cart is empty.');
      // Lock the product rows so two orders can't sell the same last unit.
      const rows = await tx
        .select()
        .from(products)
        .where(
          inArray(
            products.id,
            cart.map((c) => c.productId),
          ),
        )
        .for('update');
      const byId = new Map(rows.map((p) => [p.id, p]));
      const cats = await categoriesOf(tx, rows);
      const lines = cart.flatMap((c) => {
        const p = byId.get(c.productId);
        return p ? [{ product: { ...p, categoryIds: cats.get(p.id) ?? [] }, qty: c.qty }] : [];
      });
      const q = quote({
        lines,
        fees: settings,
        coupon,
        unknownCouponCode: body.couponCode && !coupon ? body.couponCode : null,
        paymentMethod: body.paymentMethod,
        isFirstOrder: first,
      });
      if (q.blocking || lines.length !== cart.length) {
        throw new HttpError(409, 'cart_changed', 'Some items in your cart changed. Review your cart and try again.', q);
      }
      if (body.couponCode && !q.coupon?.applied) {
        throw new HttpError(409, 'coupon_invalid', q.coupon && !q.coupon.applied ? q.coupon.reason : 'Coupon not valid.');
      }

      const address: AddressFields = {
        label: addr.label,
        otherLabel: addr.otherLabel,
        name: addr.name,
        phone: addr.phone,
        line1: addr.line1,
        line2: addr.line2,
        landmark: addr.landmark,
        city: addr.city,
        state: addr.state,
        pincode: addr.pincode,
        lat: addr.lat ? Number(addr.lat) : null,
        lng: addr.lng ? Number(addr.lng) : null,
      };
      const [o] = await tx
        .insert(orders)
        .values({
          number: `tmp-${body.idempotencyKey}`,
          userId,
          address,
          deliveryInstructions: body.instructions,
          subtotalPaise: q.subtotalPaise,
          mrpTotalPaise: q.mrpTotalPaise,
          deliveryFeePaise: q.deliveryFeePaise,
          handlingFeePaise: q.handlingFeePaise,
          codFeePaise: q.codFeePaise,
          discountPaise: q.discountPaise,
          totalPaise: q.totalPaise,
          couponCode: q.coupon?.applied ? q.coupon.code : null,
          paymentMethod: body.paymentMethod,
          paymentStatus: body.paymentMethod === 'cod' ? 'cod_due' : 'pending',
          idempotencyKey: body.idempotencyKey,
        })
        .returning();
      const [numbered] = await tx
        .update(orders)
        .set({ number: orderNumber(o.id, o.createdAt) })
        .where(eq(orders.id, o.id))
        .returning();
      await tx.insert(orderItems).values(
        lines.map(({ product: p, qty }) => ({
          orderId: o.id,
          productId: p.id,
          sku: p.sku,
          name: p.name,
          image: p.images[0] ?? null,
          qty,
          unitPricePaise: p.pricePaise,
          unitMrpPaise: Math.max(p.mrpPaise, p.pricePaise),
          returnable: p.returnable,
          returnDays: p.returnDays,
        })),
      );
      for (const { product: p, qty } of lines) {
        await tx
          .update(products)
          .set({ stockQty: sql`${products.stockQty} - ${qty}` })
          .where(eq(products.id, p.id));
      }
      await tx.insert(orderEvents).values({ orderId: o.id, status: 'placed' });
      await tx.delete(cartItems).where(eq(cartItems.userId, userId));
      await tx.insert(notifications).values({
        userId,
        kind: 'order',
        title: `Order #${numbered.number} placed`,
        body: `${q.itemCount} item${q.itemCount === 1 ? '' : 's'} · ₹${(q.totalPaise / 100).toFixed(0)}`,
        orderId: o.id,
      });
      return numbered;
    });

    reply.status(201);
    return detail(db, created);
  });

  app.get('/v1/orders', async (req) => {
    const userId = requireUser(req);
    const { filter } = parse(
      z.object({ filter: z.enum(['all', 'current', 'delivered', 'cancelled']).default('all') }),
      req.query,
    );
    const statusFilter =
      filter === 'current'
        ? inArray(orders.status, ['placed', 'confirmed', 'packed', 'out_for_delivery'])
        : filter === 'delivered'
          ? eq(orders.status, 'delivered')
          : filter === 'cancelled'
            ? eq(orders.status, 'cancelled')
            : undefined;
    const list = await db
      .select()
      .from(orders)
      .where(and(eq(orders.userId, userId), statusFilter))
      .orderBy(desc(orders.createdAt))
      .limit(50);
    const items = list.length
      ? await db
          .select()
          .from(orderItems)
          .where(
            inArray(
              orderItems.orderId,
              list.map((o) => o.id),
            ),
          )
      : [];
    const delivered = list.some((o) => o.status === 'delivered')
      ? await db
          .select({ orderId: orderEvents.orderId, at: orderEvents.createdAt })
          .from(orderEvents)
          .where(and(inArray(orderEvents.orderId, list.map((o) => o.id)), eq(orderEvents.status, 'delivered')))
      : [];
    const deliveredAt = new Map(delivered.map((e) => [e.orderId, e.at]));
    const rated = await ratingsForOrders(db, userId, list.map((o) => o.id));
    return { orders: list.map((o) => summary(o, items.filter((i) => i.orderId === o.id), deliveredAt.get(o.id) ?? null, rated.get(o.id) ?? new Map())) };
  });

  /**
   * Blinkit's "Buy again": what the customer ordered before (cancelled orders left out), most
   * recently ordered first, as product cards at today's price.
   */
  app.get('/v1/me/buy-again', async (req) => {
    const userId = requireUser(req);
    const recent = await db
      .select({ id: orderItems.productId, last: sql<string>`max(${orders.createdAt})` })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.userId, userId), ne(orders.status, 'cancelled'), isNotNull(orderItems.productId)))
      .groupBy(orderItems.productId)
      .orderBy(desc(sql`max(${orders.createdAt})`))
      .limit(30);
    const ids = recent.flatMap((r) => (r.id == null ? [] : [r.id]));
    if (!ids.length) return { items: [] };
    const rank = new Map(ids.map((id, i) => [id, i]));
    const rows = await db
      .select({ p: products, brandName: brands.name })
      .from(products)
      .leftJoin(brands, eq(brands.id, products.brandId))
      .where(and(inArray(products.id, ids), eq(products.isActive, true)));
    return {
      items: rows
        .sort((a, b) => rank.get(a.p.id)! - rank.get(b.p.id)!)
        .slice(0, 12)
        .map((r) => productCard(r.p, r.brandName ? { name: r.brandName } : null)),
    };
  });

  app.get('/v1/orders/:number', async (req) => {
    const userId = requireUser(req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    return detail(db, await loadOrder(db, userId, number));
  });

  app.post('/v1/orders/:number/cancel', async (req) => {
    const userId = requireUser(req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(200).default('Cancelled by customer') }), req.body ?? {});
    const o = await loadOrder(db, userId, number);
    if (!CANCELLABLE.includes(o.status)) {
      throw new HttpError(409, 'not_cancellable', 'This order can’t be cancelled any more. Contact support for help.');
    }
    await cancelOrder(db, o, reason);
    return detail(db, (await db.select().from(orders).where(eq(orders.id, o.id)))[0]);
  });

  /**
   * Blinkit's "Rate order": stars (1–5) and optional words for the items of a delivered order. Each
   * order is rated on its own; rating the same order again replaces what it had.
   */
  app.post('/v1/orders/:number/ratings', async (req) => {
    const userId = requireUser(req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    const body = parse(
      z.object({
        ratings: z
          .array(z.object({ productId: z.number().int().positive(), rating: z.number().int().min(1).max(5), comment: z.string().trim().max(500).nullish() }))
          .min(1)
          .max(50),
      }),
      req.body,
    );
    const o = await loadOrder(db, userId, number);
    if (o.status !== 'delivered') throw new HttpError(409, 'not_delivered', 'You can rate an order once it’s delivered.');
    const items = await db.select({ productId: orderItems.productId }).from(orderItems).where(eq(orderItems.orderId, o.id));
    const inOrder = new Set(items.flatMap((i) => (i.productId == null ? [] : [i.productId])));
    for (const r of body.ratings) {
      if (!inOrder.has(r.productId)) throw new HttpError(400, 'invalid_item', 'That item isn’t part of this order.');
    }
    await db.transaction(async (tx) => {
      for (const r of body.ratings) {
        const comment = r.comment ? r.comment : null;
        await tx
          .insert(productReviews)
          .values({ productId: r.productId, userId, orderId: o.id, rating: r.rating, comment })
          .onConflictDoUpdate({
            target: [productReviews.userId, productReviews.productId, productReviews.orderId],
            set: { rating: r.rating, comment, orderId: o.id, updatedAt: new Date() },
          });
      }
    });
    await refreshProductRatings(db, [...new Set(body.ratings.map((r) => r.productId))]);
    return detail(db, o);
  });

  app.post('/v1/orders/:number/returns', async (req, reply) => {
    const userId = requireUser(req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    const body = parse(
      z.object({
        items: z.array(z.object({ orderItemId: z.number().int(), qty: z.number().int().min(1) })).min(1),
        reason: z.enum(['damaged', 'defective', 'wrong_item', 'missing_parts']),
        details: z.string().trim().max(500).optional(),
        resolution: z.enum(['replacement', 'refund']),
      }),
      req.body,
    );
    const o = await loadOrder(db, userId, number);
    const d = await detail(db, o);
    for (const it of body.items) {
      const item = d.items.find((i) => i.id === it.orderItemId);
      if (!item) throw new HttpError(400, 'invalid_item', 'That item isn’t part of this order.');
      if (!item.canReturn) throw new HttpError(409, 'not_returnable', `${item.name} can’t be returned.`);
      if (it.qty > item.qty) throw new HttpError(400, 'invalid_qty', `You ordered ${item.qty} of ${item.name}.`);
    }
    const [r] = await db
      .insert(returnRequests)
      .values({ orderId: o.id, userId, items: body.items, reason: body.reason, details: body.details, resolution: body.resolution })
      .returning();
    await db.insert(notifications).values({
      userId,
      kind: 'order',
      title: `Return requested for #${o.number}`,
      body: 'We’ll confirm pickup shortly.',
      orderId: o.id,
    });
    reply.status(201);
    return { id: r.id, status: r.status };
  });

  /** Admin / delivery side: move an order along its lifecycle. */
  app.post('/v1/admin/orders/:number/status', async (req) => {
    requireAdmin(req);
    const { number } = parse(z.object({ number: z.string().max(40) }), req.params);
    const body = parse(
      z.object({
        status: z.enum(['confirmed', 'packed', 'out_for_delivery', 'delivered', 'cancelled']),
        note: z.string().max(200).optional(),
      }),
      req.body,
    );
    await changeOrderStatus(db, number, body.status, body.note);
    return { ok: true };
  });
}

/**
 * Move an order to its next status (store/admin side). Shared by the admin
 * route and the Wall2Roof integration API so both follow the same rules:
 * only NEXT_STATUS moves, restock on cancel, COD marked paid on delivery,
 * an order event and a customer notification.
 */
export async function changeOrderStatus(db: Db, number: string, status: Exclude<Status, 'placed'>, note?: string) {
  const [o] = await db.select().from(orders).where(eq(orders.number, number));
  if (!o) throw new HttpError(404, 'not_found', 'Order not found.');
  if (!NEXT_STATUS[o.status].includes(status)) {
    throw new HttpError(409, 'invalid_transition', `Can’t move an order from ${o.status} to ${status}.`);
  }
  if (status === 'cancelled') {
    await cancelOrder(db, o, note ?? 'Cancelled by store');
    return;
  }
  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        status,
        updatedAt: new Date(),
        ...(status === 'delivered' && o.paymentMethod === 'cod' ? { paymentStatus: 'paid' as const } : {}),
      })
      .where(eq(orders.id, o.id));
    await tx.insert(orderEvents).values({ orderId: o.id, status, note });
    await tx.insert(notifications).values({
      userId: o.userId,
      kind: 'order',
      title: `${STATUS_COPY[status]} · #${o.number}`,
      orderId: o.id,
    });
  });
}

/** Cancel, restock, and record it. Paid online orders are marked for refund. */
async function cancelOrder(db: Db, o: OrderRow, reason: string) {
  await db.transaction(async (tx) => {
    const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
    for (const i of items) {
      if (i.productId) {
        await tx
          .update(products)
          .set({ stockQty: sql`${products.stockQty} + ${i.qty}` })
          .where(eq(products.id, i.productId));
      }
    }
    await tx
      .update(orders)
      .set({
        status: 'cancelled',
        cancelReason: reason,
        updatedAt: new Date(),
        // No money moved for unpaid/COD orders; paid online orders need a refund.
        paymentStatus: o.paymentStatus === 'paid' && o.paymentMethod === 'online' ? 'refunded' : o.paymentStatus,
      })
      .where(eq(orders.id, o.id));
    await tx.insert(orderEvents).values({ orderId: o.id, status: 'cancelled', note: reason });
    await tx.insert(notifications).values({ userId: o.userId, kind: 'order', title: `Order #${o.number} cancelled`, body: reason, orderId: o.id });
  });
}
