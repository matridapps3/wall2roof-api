import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { productReviews, products, users } from '../db/schema.js';

/**
 * Each customer's latest review of each product: a customer who rated a product from several orders
 * counts once, with what they said most recently.
 */
function latestPerCustomer(db: Db, where: SQL) {
  return db
    .selectDistinctOn([productReviews.userId, productReviews.productId], {
      productId: productReviews.productId,
      userId: productReviews.userId,
      rating: productReviews.rating,
      comment: productReviews.comment,
      at: productReviews.updatedAt,
    })
    .from(productReviews)
    .where(where)
    .orderBy(productReviews.userId, productReviews.productId, desc(productReviews.updatedAt), desc(productReviews.id))
    .as('latest');
}

/** Recounts the stars shown on cards (products.rating_avg_x10 / rating_count) from the reviews. */
export async function refreshProductRatings(db: Db, productIds: number[]) {
  if (!productIds.length) return;
  const latest = latestPerCustomer(db, inArray(productReviews.productId, productIds));
  const rows = await db
    .select({ id: latest.productId, avg: sql<number>`avg(${latest.rating})::float`, n: sql<number>`count(*)::int` })
    .from(latest)
    .groupBy(latest.productId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of productIds) {
    const r = byId.get(id);
    await db
      .update(products)
      .set({ ratingAvg: r ? Math.round(r.avg * 10) : null, ratingCount: r?.n ?? 0 })
      .where(eq(products.id, id));
  }
}

export type OrderRatings = Map<number, { rating: number; comment: string | null }>;

/** What this customer gave each of these orders: order id → (product id → stars and words). */
export async function ratingsForOrders(db: Db, userId: number, orderIds: number[]) {
  const byOrder = new Map<number, OrderRatings>();
  if (!orderIds.length) return byOrder;
  const rows = await db
    .select({ orderId: productReviews.orderId, productId: productReviews.productId, rating: productReviews.rating, comment: productReviews.comment })
    .from(productReviews)
    .where(and(eq(productReviews.userId, userId), inArray(productReviews.orderId, orderIds)));
  for (const r of rows) {
    if (r.orderId == null) continue;
    const m = byOrder.get(r.orderId) ?? new Map();
    m.set(r.productId, { rating: r.rating, comment: r.comment });
    byOrder.set(r.orderId, m);
  }
  return byOrder;
}

/** "Ravi K." from "Ravi Kumar": enough to feel real without showing a full name. */
export function reviewerName(name: string | null) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'ElectroDash customer';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

/**
 * The product page's "Ratings & reviews": the average, how many people rated it, how many gave each
 * number of stars (5 down to 1), and the latest reviews with words.
 */
export async function reviewSummary(db: Db, productId: number) {
  const latest = latestPerCustomer(db, eq(productReviews.productId, productId));
  const [counts, recent] = await Promise.all([
    db
      .select({ rating: latest.rating, n: sql<number>`count(*)::int` })
      .from(latest)
      .groupBy(latest.rating),
    db
      .select({ rating: latest.rating, comment: latest.comment, at: latest.at, name: users.name })
      .from(latest)
      .innerJoin(users, eq(users.id, latest.userId))
      .where(sql`coalesce(trim(${latest.comment}), '') <> ''`)
      .orderBy(desc(latest.at))
      .limit(5),
  ]);
  const stars = [5, 4, 3, 2, 1].map((s) => counts.find((c) => c.rating === s)?.n ?? 0);
  const count = stars.reduce((a, b) => a + b, 0);
  const average = count ? Math.round((counts.reduce((sum, c) => sum + c.rating * c.n, 0) / count) * 10) / 10 : null;
  return {
    average,
    count,
    /** how many gave 5, 4, 3, 2 and 1 stars */
    stars,
    recent: recent.map((r) => ({ name: reviewerName(r.name), rating: r.rating, comment: r.comment!.trim(), at: r.at.toISOString() })),
  };
}
