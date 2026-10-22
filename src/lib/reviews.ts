import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { productReviews, products, users } from '../db/schema.js';

/** Recounts the stars shown on cards (products.rating_avg_x10 / rating_count) from the reviews. */
export async function refreshProductRatings(db: Db, productIds: number[]) {
  if (!productIds.length) return;
  const rows = await db
    .select({ id: productReviews.productId, avg: sql<number>`avg(${productReviews.rating})::float`, n: sql<number>`count(*)::int` })
    .from(productReviews)
    .where(inArray(productReviews.productId, productIds))
    .groupBy(productReviews.productId);
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of productIds) {
    const r = byId.get(id);
    await db
      .update(products)
      .set({ ratingAvg: r ? Math.round(r.avg * 10) : null, ratingCount: r?.n ?? 0 })
      .where(eq(products.id, id));
  }
}

/** This customer's ratings of these products: product id → stars and words. */
export async function ratingsBy(db: Db, userId: number, productIds: number[]) {
  if (!productIds.length) return new Map<number, { rating: number; comment: string | null }>();
  const rows = await db
    .select({ productId: productReviews.productId, rating: productReviews.rating, comment: productReviews.comment })
    .from(productReviews)
    .where(and(eq(productReviews.userId, userId), inArray(productReviews.productId, productIds)));
  return new Map(rows.map((r) => [r.productId, { rating: r.rating, comment: r.comment }]));
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
  const [counts, recent] = await Promise.all([
    db
      .select({ rating: productReviews.rating, n: sql<number>`count(*)::int` })
      .from(productReviews)
      .where(eq(productReviews.productId, productId))
      .groupBy(productReviews.rating),
    db
      .select({ rating: productReviews.rating, comment: productReviews.comment, at: productReviews.updatedAt, name: users.name })
      .from(productReviews)
      .innerJoin(users, eq(users.id, productReviews.userId))
      .where(and(eq(productReviews.productId, productId), sql`coalesce(trim(${productReviews.comment}), '') <> ''`))
      .orderBy(desc(productReviews.updatedAt))
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
